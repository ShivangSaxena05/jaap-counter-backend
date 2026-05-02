const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Initialize Firebase Admin
// On local, you might use a service account file.
// On Render, you can set FIREBASE_SERVICE_ACCOUNT_JSON as an env var.
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized via environment variable");
  } catch (err) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT_JSON:", err);
    admin.initializeApp();
  }
} else {
  // Fallback for local development if you have the ADC or default config
  admin.initializeApp();
}

const db = admin.firestore();

// --- AI Chat Endpoints ---

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { userPrompt, history, userId, sessionId } = req.body;

    if (!userPrompt) {
      return res.status(400).json({ error: 'User prompt is required' });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'google/gemini-2.0-flash-lite-001',
      messages: [
        {
          role: 'system',
          content: `You are a wise spiritual guide specializing in Hindu philosophy, Jaap, and meditation.
          Provide concise, encouraging, and soulful advice.

          LANGUAGE RULES:
          1. Respond in the EXACT language/script the user uses.
          2. If the user asks in Hindi (Devanagari), respond in Hindi (Devanagari).
          3. If the user asks in Hinglish (Hindi words in English script), respond in Hinglish.
          4. If the user asks in English, respond in English.

          STYLE:
          - CRITICAL: DO NOT start with a greeting (like Namaste, Pranam, etc.) if you have already greeted the user in this conversation.
          - Go straight to the answer.
          - Use a calm and compassionate tone.
          - Keep responses under 150 words unless asked for detail.`
        },
        ...history.slice(-6).map(msg => ({
          role: msg.isUser ? 'user' : 'assistant',
          content: msg.text
        })),
        {
          role: 'user',
          content: userPrompt
        }
      ],
      max_tokens: 500,
      temperature: 0.7,
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      timeout: 15000
    });

    const aiMessage = response.data.choices[0].message.content;

    // Save or Update Session metadata and messages
    if (userId && sessionId) {
      const sessionRef = db.collection('users').doc(userId).collection('ai_sessions').doc(sessionId);
      const sessionDoc = await sessionRef.get();

      if (!sessionDoc.exists) {
        await sessionRef.set({
          title: userPrompt.length > 40 ? userPrompt.substring(0, 37) + '...' : userPrompt,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await sessionRef.update({
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      const messagesRef = sessionRef.collection('messages');

      // Save user message
      await messagesRef.add({
        text: userPrompt,
        isUser: true,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Save AI message
      await messagesRef.add({
        text: aiMessage,
        isUser: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ content: aiMessage });
  } catch (error) {
    console.error('AI Chat Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to get spiritual advice' });
  }
});

app.get('/api/ai/sessions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const sessionsRef = db.collection('users').doc(userId).collection('ai_sessions');
    const snapshot = await sessionsRef.orderBy('lastMessageAt', 'desc').limit(50).get();

    const sessions = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      sessions.push({
        id: doc.id,
        title: data.title || 'Untitled Conversation',
        lastMessageAt: data.lastMessageAt,
        createdAt: data.createdAt,
      });
    });

    res.json(sessions);
  } catch (error) {
    console.error('Fetch Sessions Error:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.delete('/api/ai/sessions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { sessionIds } = req.body; // Array of IDs

    if (!sessionIds || !Array.isArray(sessionIds)) {
      return res.status(400).json({ error: 'sessionIds array is required' });
    }

    const batch = db.batch();
    sessionIds.forEach(id => {
      const sessionRef = db.collection('users').doc(userId).collection('ai_sessions').doc(id);
      batch.delete(sessionRef);
    });

    await batch.commit();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete Sessions Error:', error);
    res.status(500).json({ error: 'Failed to delete sessions' });
  }
});

app.get('/api/ai/history/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;
    const messagesRef = db.collection('users').doc(userId).collection('ai_sessions').doc(sessionId).collection('messages');
    const snapshot = await messagesRef.orderBy('timestamp', 'asc').limit(20).get();

    const history = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      history.push({
        text: data.text,
        isUser: data.isUser
      });
    });

    res.json(history);
  } catch (error) {
    console.error('Fetch History Error:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// --- Auth Endpoints ---

app.post('/api/auth/delete-account', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'ID Token required' });

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // 1. Clean up Firestore data
    const userRef = db.collection('users').doc(uid);
    const historyRef = userRef.collection('history');
    const progressRef = userRef.collection('progress');
    const aiSessionsRef = userRef.collection('ai_sessions');

    // Batch delete helper (simplified for this context)
    const deleteCollection = async (collectionRef) => {
      const snapshot = await collectionRef.get();
      const batch = db.batch();
      snapshot.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    };

    await Promise.all([
      deleteCollection(historyRef),
      deleteCollection(progressRef),
      deleteCollection(aiSessionsRef),
      userRef.delete()
    ]);

    // 2. Delete Auth User
    await admin.auth().deleteUser(uid);

    res.json({ success: true, message: 'Account and data deleted successfully' });
  } catch (error) {
    console.error('Delete Account Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
