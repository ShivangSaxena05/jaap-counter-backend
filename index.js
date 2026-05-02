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
  'google/gemini-2.0-flash-exp:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-4-maverick:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'deepseek/deepseek-r1:free',
];

let activeModel = null;
let lastModelCheck = null;
const MODEL_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

async function getWorkingModel(apiKey) {
  const now = Date.now();

  // Return cached model if still valid
  if (activeModel && lastModelCheck && (now - lastModelCheck) < MODEL_CACHE_DURATION) {
    return activeModel;
  }

  console.log('🔍 Finding working free model...');

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
    }
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
          content: `You are a wise spiritual guide specializing in Hindu philosophy, Jaap, and meditation.
          Provide concise, encouraging, and soulful advice.
          LANGUAGE RULES: 1. Respond in the EXACT script used. 2. Hindi for Hindi, Hinglish for Hinglish, English for English.
          STYLE: Go straight to the answer. No repetitive greetings.`
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

    const aiMessage = response.data.choices?.[0]?.message?.content;
    if (!aiMessage) throw new Error("No response from AI model");

    // Save to Firestore
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

// ... (Keep the rest of your get/delete endpoints here)

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});