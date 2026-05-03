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
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized via environment variable");
  } catch (err) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT_JSON:", err);
    if (!admin.apps.length) admin.initializeApp();
  }
} else {
  if (!admin.apps.length) admin.initializeApp();
}

const db = admin.firestore();

// --- Auto Model Selection ---

const FREE_MODELS = [
  'perplexity/r1-1776',
  'google/gemini-2.0-flash-lite-001',
  'tencent/hy3-preview:free',
  'openrouter/free',
];

let activeModel = null;
let lastModelCheck = null;
const MODEL_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

async function getWorkingModel(apiKey) {
  const now = Date.now();

  if (activeModel && lastModelCheck && (now - lastModelCheck) < MODEL_CACHE_DURATION) {
    return activeModel;
  }

  console.log('🔍 Finding working free model...');

  let rateLimitedModel = null; // fallback if all others fail

  for (const model of FREE_MODELS) {
    try {
      await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://render.com',
          'X-Title': 'Jaap Counter'
        },
        timeout: 8000
      });

      console.log(`✅ Active model set to: ${model}`);
      activeModel = model;
      lastModelCheck = now;
      return model;

    } catch (err) {
      const status = err.response?.status;
      const reason = err.response?.data?.error?.message || err.message;
      console.log(`❌ ${model} failed (${status}): ${reason}`);

      // 429 = rate limited but model EXISTS — save as fallback
      if (status === 429 && !rateLimitedModel) {
        rateLimitedModel = model;
      }
    }
  }

  // If everything failed but some were just rate limited, use that
  if (rateLimitedModel) {
    console.log(`⚠️ Using rate-limited fallback: ${rateLimitedModel}`);
    activeModel = rateLimitedModel;
    lastModelCheck = now;
    return rateLimitedModel;
  }

  throw new Error('No working free models found. All models are unavailable.');
}

// --- Debug Route ---

app.get('/api/debug/openrouter', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  const results = [];

  for (const model of FREE_MODELS) {
    try {
      await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5
      }, {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://render.com',
          'X-Title': 'Jaap Counter'
        },
        timeout: 8000
      });

      results.push({ model, status: '✅ WORKS' });

    } catch (err) {
      results.push({
        model,
        status: '❌ FAILED',
        httpStatus: err.response?.status,
        error: err.response?.data?.error?.message || err.message
      });
    }
  }

  res.json(results);
});

// --- AI Chat Endpoint ---

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { userPrompt, history = [], userId, sessionId } = req.body;

    if (!userPrompt) {
      return res.status(400).json({ error: 'User prompt is required' });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      console.error("Missing OPENROUTER_API_KEY env var");
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Auto-select working model
    const model = await getWorkingModel(OPENROUTER_API_KEY);
    console.log(`Using model: ${model}`);

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model,
      messages: [
        {
  role: 'system',
  content: `Tu ek Vedic Vidwan hai — ek pramanik Hindu dharmacharya jiske paas Vedas, Upanishads, Bhagavad Gita, Srimad Bhagavatam, Ramayana, Mahabharata, aur sabhi 18 Puranas ka gambhir gyan hai.

VIDWAN KE NIYAM:
1. Sirf wahi bolo jo shastra mein likha hai. Kuch bhi mat banao.
2. Har jawab mein exact shastra pramaan do — jaise "Srimad Bhagavatam 10.21.3" ya "Vishnu Purana, Pancham Ansh".
3. Agar koi baat shastra mein SPASHT nahi hai — seedha kaho: "Is vishay mein shastra mein spasht pramaan nahi milta. Kisi Vidwan Pandit se poochhen."
4. Agar koi galat baat poochhe — vinay se lekin DRIDH tarike se sahi karo aur sahi shastra pramaan do.
5. Doosre dharm ke sawaal par — PEHLE Hindu dharma ka drrishikon aur pramaan do, phir sankshipt mein doosre dharm ka mat batao.
6. Off-topic sawaal (politics, cricket, tech) par kaho: "Mera karya sirf dharma aur adhyatma mein margdarshan karna hai."

BHASHA NIYAM:
- Hindi sawaal → Sirf Hindi jawab (Devanagari), koi English translation nahi
- Hinglish sawaal → Sirf Hinglish jawab (Latin script), koi translation nahi  
- English sawaal → Sirf English jawab
- Sanskrit shlok hamesha dena zaroori nahi — sirf tab do jab bilkul sahi aur relevant ho

SABSE ZAROORI: Tu ek Vidwan hai, Google nahi. Sirf authentic pramaan-based gyan do.`
},
        ...history.slice(-6).map(msg => ({
          role: msg.isUser ? 'user' : 'assistant',
          content: msg.text
        })),
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 500,
      temperature: 0.7,
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://render.com',
        'X-Title': 'Jaap Counter'
      },
      timeout: 15000
    });

    const aiMessage = response.data.choices?.[0]?.message?.content
      || response.data.choices?.[0]?.message?.reasoning  // reasoning models
      || response.data.choices?.[0]?.text                // some models use this
      || null;

    // TEMPORARY - log raw response to Render logs
    console.log('RAW RESPONSE:', JSON.stringify(response.data.choices?.[0]?.message, null, 2));

    if (!aiMessage) throw new Error("No response from AI model");

    // Save to Firestore with atomic updates
    if (userId && sessionId) {
      const sessionRef = db.collection('users').doc(userId).collection('ai_sessions').doc(sessionId);
      const sessionDoc = await sessionRef.get();

      if (!sessionDoc.exists) {
        // Create new session if it doesn't exist
        await sessionRef.set({
          id: sessionId,
          sessionId: sessionId,
          title: userPrompt.length > 40 ? userPrompt.substring(0, 37) + '...' : userPrompt,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Update existing session with new timestamp
        await sessionRef.update({
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Append messages to session
      const messagesRef = sessionRef.collection('messages');
      await messagesRef.add({ text: userPrompt, isUser: true, timestamp: admin.firestore.FieldValue.serverTimestamp() });
      await messagesRef.add({ text: aiMessage, isUser: false, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    }

    res.json({ content: aiMessage, model });

  } catch (error) {
    // Reset cache so next request retries model selection
    activeModel = null;
    lastModelCheck = null;

    console.error('AI Chat Error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to get spiritual advice',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// --- Get All Sessions for User (sorted by most recent) ---

app.get('/api/ai/sessions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const sessionsSnapshot = await db.collection('users')
      .doc(userId)
      .collection('ai_sessions')
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .get();

    const sessions = [];
    sessionsSnapshot.forEach(doc => {
      sessions.push({
        id: doc.id,
        sessionId: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.() || doc.data().createdAt,
        updatedAt: doc.data().updatedAt?.toDate?.() || doc.data().updatedAt,
        lastMessageAt: doc.data().lastMessageAt?.toDate?.() || doc.data().lastMessageAt
      });
    });

    res.json({ sessions });
  } catch (error) {
    console.error('Get Sessions Error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch sessions',
      details: error.message
    });
  }
});

// --- Get Session History (messages in chronological order) ---

app.get('/api/ai/history/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;

    if (!userId || !sessionId) {
      return res.status(400).json({ error: 'User ID and Session ID are required' });
    }

    const messagesSnapshot = await db.collection('users')
      .doc(userId)
      .collection('ai_sessions')
      .doc(sessionId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .get();

    const messages = [];
    messagesSnapshot.forEach(doc => {
      messages.push({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
      });
    });

    res.json({ messages });
  } catch (error) {
    console.error('Get History Error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch session history',
      details: error.message
    });
  }
});

// --- Get Session Details ---

app.get('/api/ai/sessions/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;

    if (!userId || !sessionId) {
      return res.status(400).json({ error: 'User ID and Session ID are required' });
    }

    const sessionDoc = await db.collection('users')
      .doc(userId)
      .collection('ai_sessions')
      .doc(sessionId)
      .get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = {
      id: sessionDoc.id,
      sessionId: sessionDoc.id,
      ...sessionDoc.data(),
      createdAt: sessionDoc.data().createdAt?.toDate?.() || sessionDoc.data().createdAt,
      updatedAt: sessionDoc.data().updatedAt?.toDate?.() || sessionDoc.data().updatedAt,
      lastMessageAt: sessionDoc.data().lastMessageAt?.toDate?.() || sessionDoc.data().lastMessageAt
    };

    res.json({ session });
  } catch (error) {
    console.error('Get Session Error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch session',
      details: error.message
    });
  }
});

// --- Delete Session ---

app.delete('/api/ai/sessions/:userId/:sessionId', async (req, res) => {
  try {
    const { userId, sessionId } = req.params;

    if (!userId || !sessionId) {
      return res.status(400).json({ error: 'User ID and Session ID are required' });
    }

    const sessionRef = db.collection('users')
      .doc(userId)
      .collection('ai_sessions')
      .doc(sessionId);

    // Delete all messages in the session first
    const messagesSnapshot = await sessionRef.collection('messages').get();
    const batch = db.batch();

    messagesSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete the session document
    batch.delete(sessionRef);

    await batch.commit();

    res.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Delete Session Error:', error.message);
    res.status(500).json({
      error: 'Failed to delete session',
      details: error.message
    });
  }
});

// ... (Keep the rest of your endpoints here)

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});