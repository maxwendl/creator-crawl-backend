/* =====================================================================
   Creator Crawl Phase 4 — Backend Server (PATCHED)
   Ideas-based AI pipeline: Claude (analysis) + Gemini (embeddings) + Pinecone (vector search)
   ===================================================================== */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

try {
  admin.initializeApp();
} catch (e) {
  console.log('Firebase already initialized');
}

// IMPORTANT: this must stay 'creator-crawl' — the named database, not the default one.
const db = getFirestore('creator-crawl');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const SHARED_EMAIL = process.env.SHARED_EMAIL || 'user@example.com';
const SHARED_PASSWORD = process.env.SHARED_PASSWORD || 'password';
const CREATORC_API_KEY = process.env.CREATORC_API_KEY || '';
const CC_BASE = 'https://app.creatorcrawl.com/api';

// New AI providers
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX || 'ideas');

// Shared secret for Cloud Scheduler → protects /api/crawl/run from public access
const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET || 'change-this-too';

/* --------- Standardized tag vocabulary (fixed, not AI-invented) --------- */
const TAG_VOCABULARY = [
  'tutorial', 'behind_the_scenes', 'trending_audio', 'text_overlay_heavy',
  'fast_cuts', 'voiceover', 'talking_head', 'before_after',
  'educational', 'entertainment', 'promotional', 'inspirational', 'trending_topic',
  'low_production', 'medium_production', 'high_production'
];

/* --------- Middleware --------- */
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function verifySchedulerSecret(req, res, next) {
  if (req.headers['x-scheduler-secret'] !== SCHEDULER_SECRET) {
    return res.status(401).json({ error: 'Invalid scheduler secret' });
  }
  next();
}

/* --------- Auth (unchanged) --------- */
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (email === SHARED_EMAIL && password === SHARED_PASSWORD) {
    const token = jwt.sign({ email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});
app.post('/auth/logout', (req, res) => res.json({ message: 'Logged out' }));

/* --------- Handles (unchanged CRUD, kept from Phase 3) --------- */
app.get('/api/handles', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('handles')
      .where('user_id', '==', req.user.email)
      .orderBy('created_at', 'desc').get();
    res.json({ handles: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/handles', verifyToken, async (req, res) => {
  const { handle, frequency } = req.body;
  if (!handle || !frequency) return res.status(400).json({ error: 'handle and frequency required' });
  try {
    const docRef = db.collection('handles').doc();
    await docRef.set({
      user_id: req.user.email,
      handle: handle.replace(/^@/, ''),
      frequency,
      enabled: true,
      last_crawled_at: null,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ message: 'Handle created', id: docRef.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/handles/:id', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('handles').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Handle not found' });
    }
    await docRef.update(req.body);
    res.json({ message: 'Handle updated' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/handles/:id', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('handles').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Handle not found' });
    }
    await docRef.delete();
    res.json({ message: 'Handle deleted' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* --------- Categories (extended with ai_prompt + calculation_type) --------- */
app.get('/api/categories', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('categories')
      .where('user_id', '==', req.user.email)
      .orderBy('order', 'asc').get();
    res.json({ categories: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/categories', verifyToken, async (req, res) => {
  const {
    field_name, display_name, type, required, order,
    calculation_type,
    ai_prompt,
    formula
  } = req.body;
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
      calculation_type: calculation_type || 'ai_generated',
      ai_prompt: ai_prompt || null,
      formula: formula || null,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ message: 'Category created', field_name });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/categories/:field_name', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('categories').doc(req.params.field_name);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Category not found' });
    }
    await docRef.update(req.body);
    res.json({ message: 'Category updated' });
  } catch (err) { res.status(400).json({ error: err.message }); }
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
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* =====================================================================
   AI HELPERS
   ===================================================================== */

async function analyzeReelWithClaude(mediaUrl, categories) {
  const categoryList = categories
    .filter(c => c.calculation_type !== 'mathematical')
    .map(c => `- ${c.field_name} (${c.type}): ${c.ai_prompt || c.display_name}`)
    .join('\n');

  const prompt = `You are analyzing a short-form video (Instagram Reel) at this URL: ${mediaUrl}

Return ONLY valid JSON with this exact structure:
{
  "description": "neutral, objective description of the core concept/idea of this video (not the specific execution — the underlying reusable idea)",
  "production_blueprint": "how this type of video is structured, step by step, so someone could recreate the format with different content",
  "tags": ["pick only from this fixed vocabulary: ${TAG_VOCABULARY.join(', ')}"],
  "fields": {
${categoryList ? categoryList.split('\n').map(l => `    // ${l}`).join('\n') : '    // no AI fields configured'}
  }
}

Fill "fields" with one key per category listed above, using the described prompt for each to decide the value.`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

async function generateEmbedding(text) {
  const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

async function findSimilarIdeas(embedding, tags, topK = 5) {
  const queryResult = await pineconeIndex.query({
    vector: embedding,
    topK,
    includeMetadata: true,
    filter: tags && tags.length ? { tags: { $in: tags } } : undefined
  });
  return queryResult.matches || [];
}

async function decideIdeaMatch(newDescription, candidates) {
  if (!candidates.length) return { match: false };

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ID: ${c.id}\nDescription: ${c.metadata.description}`)
    .join('\n\n');

  const prompt = `New video idea:\n${newDescription}\n\nExisting candidate ideas:\n${candidateList}\n\n` +
    `Does the new video represent the SAME underlying idea as one of these candidates? ` +
    `Reply ONLY with valid JSON: {"match": true, "idea_id": "..."} or {"match": false}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { match: false };
  return JSON.parse(jsonMatch[0]);
}

/* =====================================================================
   SCHEDULING LOGIC
   ===================================================================== */

const FREQUENCY_DAYS = {
  daily: 1,
  weekly: 7,
  'bi-weekly': 14,
  monthly: 30,
  'bi-monthly': 60
};

function isDueToday(handle) {
  if (!handle.enabled) return false;
  if (!handle.last_crawled_at) return true;
  const daysSince = (Date.now() - handle.last_crawled_at.toMillis()) / 86400000;
  return daysSince >= (FREQUENCY_DAYS[handle.frequency] || 1);
}

/* =====================================================================
   MAIN CRAWL PIPELINE (PATCHED with better error handling)
   ===================================================================== */

async function runCrawlForUser(userEmail) {
  const handlesSnap = await db.collection('handles').where('user_id', '==', userEmail).get();
  const dueHandles = handlesSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isDueToday);

  const categoriesSnap = await db.collection('categories').where('user_id', '==', userEmail).get();
  const categories = categoriesSnap.docs.map(d => d.data());

  const runLog = {
    user_id: userEmail,
    started_at: admin.firestore.FieldValue.serverTimestamp(),
    handles_processed: [],
    errors: []
  };

  for (const handle of dueHandles) {
    try {
      // Step 1: Fetch reels from CreatorCrawl API with proper error handling
      console.log(`Fetching reels for @${handle.handle}...`);
      
      const ccResp = await fetch(`${CC_BASE}/reels?handle=${handle.handle}&count=25`, {
        headers: { 'Authorization': `Bearer ${CREATORC_API_KEY}` }
      });

      // Check HTTP status first
      if (!ccResp.ok) {
        throw new Error(`CreatorCrawl API error: ${ccResp.status} ${ccResp.statusText}`);
      }

      // Check content-type to ensure it's JSON
      const contentType = ccResp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await ccResp.text();
        throw new Error(`CreatorCrawl returned non-JSON: ${contentType} - ${text.slice(0, 100)}`);
      }

      // Now safe to parse as JSON
      const ccData = await ccResp.json();
      const reels = ccData.reels || [];

      if (!Array.isArray(reels)) {
        throw new Error(`CreatorCrawl returned invalid reel array: ${JSON.stringify(ccData).slice(0, 100)}`);
      }

      console.log(`Got ${reels.length} reels for @${handle.handle}`);

      let newCount = 0;
      for (const reel of reels) {
        try {
          // Step 2: skip if already in DB
          const existing = await db.collection('content').doc(reel.id).get();
          if (existing.exists) continue;

          // Step 3: analyze
          const analysis = await analyzeReelWithClaude(reel.media_url, categories);

          // Step 4: embedding + vector search
          const embedding = await generateEmbedding(analysis.description);
          const candidates = await findSimilarIdeas(embedding, analysis.tags);
          const decision = await decideIdeaMatch(analysis.description, candidates);

          let ideaId;
          if (decision.match && decision.idea_id) {
            ideaId = decision.idea_id;
            await db.collection('ideas').doc(ideaId)
              .collection('source_reels').doc(reel.id).set({
                ...reel, analyzed_at: admin.firestore.FieldValue.serverTimestamp()
              });
          } else {
            const ideaRef = db.collection('ideas').doc();
            ideaId = ideaRef.id;
            await ideaRef.set({
              description: analysis.description,
              production_blueprint: analysis.production_blueprint,
              tags: analysis.tags,
              created_at: admin.firestore.FieldValue.serverTimestamp()
            });
            await ideaRef.collection('source_reels').doc(reel.id).set({
              ...reel, analyzed_at: admin.firestore.FieldValue.serverTimestamp()
            });
            await pineconeIndex.upsert([{
              id: ideaId,
              values: embedding,
              metadata: { description: analysis.description, tags: analysis.tags }
            }]);
          }

          // Store reel + AI fields + link to idea
          await db.collection('content').doc(reel.id).set({
            user_id: userEmail,
            source_handle: handle.handle,
            idea_id: ideaId,
            ...reel,
            ai_fields: analysis.fields,
            created_at: admin.firestore.FieldValue.serverTimestamp()
          });

          newCount++;
        } catch (reelErr) {
          console.error(`Error processing reel ${reel?.id}:`, reelErr.message);
          // Continue with next reel, don't fail the whole handle
        }
      }

      await db.collection('handles').doc(handle.id).update({
        last_crawled_at: admin.firestore.FieldValue.serverTimestamp()
      });

      runLog.handles_processed.push({ handle: handle.handle, new_reels: newCount });
    } catch (handleErr) {
      console.error(`Error crawling @${handle.handle}:`, handleErr.message);
      runLog.errors.push({ handle: handle.handle, error: handleErr.message });
    }
  }

  runLog.finished_at = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('ai_runs').add(runLog);
  return runLog;
}

// Cloud Scheduler hits this
app.post('/api/crawl/run', verifySchedulerSecret, async (req, res) => {
  try {
    const result = await runCrawlForUser(SHARED_EMAIL);
    res.json({ message: 'Crawl complete', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual trigger from the UI
app.post('/api/crawl/run-now', verifyToken, async (req, res) => {
  try {
    const result = await runCrawlForUser(req.user.email);
    res.json({ message: 'Crawl complete', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* --------- Ideas (read endpoints) --------- */
app.get('/api/ideas', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('ideas').orderBy('created_at', 'desc').limit(100).get();
    res.json({ ideas: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/ideas/:id', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('ideas').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Idea not found' });
    const reelsSnap = await doc.ref.collection('source_reels').get();
    res.json({
      idea: { id: doc.id, ...doc.data() },
      source_reels: reelsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* --------- Content (unchanged) --------- */
app.get('/api/content', verifyToken, async (req, res) => {
  try {
    let query = db.collection('content').where('user_id', '==', req.user.email);
    if (req.query.handle) query = query.where('source_handle', '==', req.query.handle);
    const snap = await query.orderBy('created_at', 'desc').limit(100).get();
    res.json({ content: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* --------- Dashboard (unchanged) --------- */
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const handlesSnap = await db.collection('handles').where('user_id', '==', req.user.email).get();
    const contentSnap = await db.collection('content')
      .where('user_id', '==', req.user.email).orderBy('created_at', 'desc').limit(10).get();
    const runsSnap = await db.collection('ai_runs')
      .where('user_id', '==', req.user.email).orderBy('started_at', 'desc').limit(5).get();
    res.json({
      summary: {
        total_handles: handlesSnap.size,
        total_content: contentSnap.size,
        recent_content: contentSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        recent_runs: runsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      }
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* --------- Health check --------- */
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Creator Crawl Phase 4 backend listening on port ${PORT}`));
