/* =====================================================================
   Creator Crawl Phase 3 — Backend Server
   Full AI-powered content pipeline
   ===================================================================== */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

try {
  admin.initializeApp();
} catch (e) {
  console.log('Firebase already initialized');
}

const db = admin.firestore('creator-crawl');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const SHARED_EMAIL = process.env.SHARED_EMAIL || 'user@example.com';
const SHARED_PASSWORD = process.env.SHARED_PASSWORD || 'password';
const CREATORC_API_KEY = process.env.CREATORC_API_KEY || '';
const HF_API_KEY = process.env.HF_API_KEY || '';
const CC_BASE = 'https://app.creatorcrawl.com/api';

// Middleware: verify JWT token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/* --------- Auth --------- */
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  if (email === SHARED_EMAIL && password === SHARED_PASSWORD) {
    const token = jwt.sign({ email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.json({ message: 'Logged out' });
});

/* --------- Handles --------- */
app.get('/api/handles', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('handles')
      .where('user_id', '==', req.user.email)
      .orderBy('created_at', 'desc')
      .get();
    
    const handles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ handles });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/handles', verifyToken, async (req, res) => {
  const { handle, frequency, ai_config } = req.body;
  if (!handle || !frequency) return res.status(400).json({ error: 'handle and frequency required' });
  
  try {
    const docRef = db.collection('handles').doc();
    await docRef.set({
      user_id: req.user.email,
      handle: handle.replace(/^@/, ''),
      frequency,
      enabled: true,
      ai_config: ai_config || {
        description_prompt: 'Analyze this video and provide a detailed description.',
        extraction_prompt: 'Extract the requested data from this video description.',
        evaluation_prompt: 'Determine if this is new content or a duplicate.',
        temperature: 0.7,
        max_tokens: 1024
      },
      last_crawled_at: null,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ message: 'Handle created', id: docRef.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/handles/:handle', verifyToken, async (req, res) => {
  const { frequency, enabled, ai_config } = req.body;
  
  try {
    const snap = await db.collection('handles')
      .where('user_id', '==', req.user.email)
      .where('handle', '==', req.params.handle)
      .limit(1)
      .get();
    
    if (snap.empty) return res.status(404).json({ error: 'Handle not found' });
    
    const docRef = snap.docs[0].ref;
    const updateData = {};
    if (frequency) updateData.frequency = frequency;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (ai_config) updateData.ai_config = ai_config;
    
    await docRef.update(updateData);
    res.json({ message: 'Handle updated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/handles/:handle', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('handles')
      .where('user_id', '==', req.user.email)
      .where('handle', '==', req.params.handle)
      .limit(1)
      .get();
    
    if (snap.empty) return res.status(404).json({ error: 'Handle not found' });
    
    await snap.docs[0].ref.delete();
    res.json({ message: 'Handle deleted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Categories --------- */
app.get('/api/categories', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('categories')
      .where('user_id', '==', req.user.email)
      .orderBy('order', 'asc')
      .get();
    
    const categories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ categories });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/categories', verifyToken, async (req, res) => {
  const { field_name, display_name, type, required, order } = req.body;
  if (!field_name || !display_name || !type) {
    return res.status(400).json({ error: 'field_name, display_name, type required' });
  }
  
  try {
    await db.collection('categories').doc(field_name).set({
      user_id: req.user.email,
      field_name,
      display_name,
      type,
      required: required || false,
      order: order || 999,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ message: 'Category created', field_name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/categories/:field_name', verifyToken, async (req, res) => {
  const { display_name, type, required, order } = req.body;
  
  try {
    const docRef = db.collection('categories').doc(req.params.field_name);
    const doc = await docRef.get();
    
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Category not found' });
    }
    
    const updateData = {};
    if (display_name) updateData.display_name = display_name;
    if (type) updateData.type = type;
    if (required !== undefined) updateData.required = required;
    if (order !== undefined) updateData.order = order;
    
    await docRef.update(updateData);
    res.json({ message: 'Category updated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/categories/:field_name', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('categories').doc(req.params.field_name);
    const doc = await docRef.get();
    
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Category not found' });
    }
    
    await docRef.delete();
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Content --------- */
app.get('/api/content', verifyToken, async (req, res) => {
  try {
    let query = db.collection('content').where('user_id', '==', req.user.email);
    
    if (req.query.handle) {
      query = query.where('source_handle', '==', req.query.handle);
    }
    
    const snap = await query.orderBy('created_at', 'desc').limit(100).get();
    const content = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/content/:id', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('content').doc(req.params.id).get();
    
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Content not found' });
    }
    
    res.json({ content: { id: doc.id, ...doc.data() } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/content/:id', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('content').doc(req.params.id);
    const doc = await docRef.get();
    
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Content not found' });
    }
    
    const { topic, sentiment, key_points, video_description, ...otherFields } = req.body;
    const updateData = {
      ...otherFields,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (topic) updateData.topic = topic;
    if (sentiment) updateData.sentiment = sentiment;
    if (key_points) updateData.key_points = key_points;
    if (video_description) updateData.video_description = video_description;
    
    await docRef.update(updateData);
    res.json({ message: 'Content updated' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/content/:id', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('content').doc(req.params.id);
    const doc = await docRef.get();
    
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Content not found' });
    }
    
    await docRef.delete();
    res.json({ message: 'Content deleted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- AI Pipeline Orchestration --------- */
async function callHuggingFace(model, messages, temperature, maxTokens) {
  if (!HF_API_KEY) throw new Error('HF_API_KEY not configured');
  
  try {
    const resp = await fetch('https://api-inference.huggingface.co/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature || 0.7,
        max_tokens: maxTokens || 1024,
      }),
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HF API error: ${resp.status} ${err}`);
    }
    
    const data = await resp.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      tokens_used: data.usage?.total_tokens || 0,
      model
    };
  } catch (err) {
    throw new Error(`Hugging Face call failed: ${err.message}`);
  }
}

app.post('/api/ai/analyze', verifyToken, async (req, res) => {
  const { video_url, handle } = req.body;
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  
  try {
    // Get user's categories and handle config
    const handleSnap = await db.collection('handles')
      .where('user_id', '==', req.user.email)
      .where('handle', '==', (handle || ''))
      .limit(1)
      .get();
    
    const handleConfig = handleSnap.empty ? {} : handleSnap.docs[0].data();
    const aiConfig = handleConfig.ai_config || {};
    
    const categoriesSnap = await db.collection('categories')
      .where('user_id', '==', req.user.email)
      .get();
    
    const categories = categoriesSnap.docs.map(d => d.data());
    
    // Step 1: Description AI
    const descriptionResult = await callHuggingFace(
      'meta-llama/Meta-Llama-3-8B-Instruct',
      [{
        role: 'user',
        content: `${aiConfig.description_prompt || 'Analyze this video and provide a detailed description.'}\n\nVideo URL: ${video_url}`
      }],
      aiConfig.temperature,
      aiConfig.max_tokens
    );
    
    // Step 2: Extraction AI
    const categoryList = categories.map(c => `- ${c.field_name} (${c.type})`).join('\n');
    const extractionResult = await callHuggingFace(
      'meta-llama/Meta-Llama-3-8B-Instruct',
      [{
        role: 'user',
        content: `${aiConfig.extraction_prompt || 'Extract these fields from the video:'}\n\nCategories:\n${categoryList}\n\nVideo description:\n${descriptionResult.content}`
      }],
      aiConfig.temperature,
      aiConfig.max_tokens
    );
    
    // Step 3: Evaluation AI (duplicate check)
    const contentSnap = await db.collection('content')
      .where('user_id', '==', req.user.email)
      .limit(10)
      .get();
    
    const existingContent = contentSnap.docs
      .map(d => `- ${d.data().topic || 'N/A'}: ${d.data().video_description || 'N/A'}`)
      .join('\n');
    
    const evaluationResult = await callHuggingFace(
      'meta-llama/Meta-Llama-3-8B-Instruct',
      [{
        role: 'user',
        content: `${aiConfig.evaluation_prompt || 'Is this new or duplicate?'}\n\nNew video: ${extractionResult.content}\n\nExisting content:\n${existingContent}`
      }],
      aiConfig.temperature,
      aiConfig.max_tokens
    );
    
    res.json({
      analysis: {
        description: descriptionResult.content,
        extraction: extractionResult.content,
        evaluation: evaluationResult.content,
        tokens_used: descriptionResult.tokens_used + extractionResult.tokens_used + evaluationResult.tokens_used
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/runs', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('ai_runs')
      .where('user_id', '==', req.user.email)
      .orderBy('started_at', 'desc')
      .limit(50)
      .get();
    
    const runs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ runs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Dashboard --------- */
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const handlesSnap = await db.collection('handles')
      .where('user_id', '==', req.user.email)
      .get();
    
    const contentSnap = await db.collection('content')
      .where('user_id', '==', req.user.email)
      .orderBy('created_at', 'desc')
      .limit(10)
      .get();
    
    const runsSnap = await db.collection('ai_runs')
      .where('user_id', '==', req.user.email)
      .orderBy('started_at', 'desc')
      .limit(5)
      .get();
    
    res.json({
      summary: {
        total_handles: handlesSnap.size,
        total_content: contentSnap.size,
        recent_content: contentSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        recent_runs: runsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Health check --------- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Creator Crawl Phase 3 backend listening on port ${PORT}`);
});
