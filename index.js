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
app.use(cors()); // For production, use: cors({ origin: 'https://your-frontend.com' })
app.use(morgan('dev'));
app.use(express.json());

// Initialize Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized via environment variable");
  } catch (err) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT_JSON:", err);
    // Attempt fallback
    if (!admin.apps.length) admin.initializeApp();
  }
} else {
  if (!admin.apps.length) admin.initializeApp();
}

const db = admin.firestore();

// --- AI Chat Endpoints ---

app.post('/api/ai/chat', async (req, res) => {
  try {
    // 1. Destructure with defaults to prevent crashes
    const { userPrompt, history = [], userId, sessionId } = req.body;

    if (!userPrompt) {
      return res.status(400).json({ error: 'User prompt is required' });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
        console.error("Missing OPENROUTER_API_KEY env var");
        return res.status(500).json({ error: 'Server configuration error' });
    }

    // 2. OpenRouter Call
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'google/gemini-2.0-flash-lite-001',
      messages: [
        {
          role: 'system',
          content: `You are a wise spiritual guide specializing in Hindu philosophy, Jaap, and meditation.
          Provide concise, encouraging, and soulful advice.
          LANGUAGE RULES: 1. Respond in the EXACT script used. 2. Hindi for Hindi, Hinglish for Hinglish, English for English.
          STYLE: Go straight to the answer. No repetitive greetings.`
        },
        // Ensure history is sliced safely
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
        'HTTP-Referer': 'https://render.com', // Required by some OpenRouter models
        'X-Title': 'Jaap Counter'
      },
      timeout: 15000
    });

    const aiMessage = response.data.choices?.[0]?.message?.content;
    if (!aiMessage) throw new Error("No response from AI model");

    // 3. Save to Firestore (Async - don't block the response)
    if (userId && sessionId) {
      const sessionRef = db.collection('users').doc(userId).collection('ai_sessions').doc(sessionId);
      
      // Update session metadata
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

      // Add messages to subcollection
      const messagesRef = sessionRef.collection('messages');
      await messagesRef.add({
        text: userPrompt,
        isUser: true,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      await messagesRef.add({
        text: aiMessage,
        isUser: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ content: aiMessage });
  } catch (error) {
    // Better logging for debugging Render logs
    console.error('AI Chat Error:', error.response?.data || error.message);
    res.status(500).json({ 
        error: 'Failed to get spiritual advice',
        details: error.message 
    });
  }
});

// ... (Keep the rest of your get/delete endpoints as they are)

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});