/* =====================================================================
   Creator Crawl Phase 5 — Backend Server
   Ideas pipeline: Gemini (video analysis + embeddings) + Claude (idea matching)
   + Tag Groups + Live Crawl Status + Category management
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

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX || 'ideas');

const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET || 'change-this-too';

// Default starting estimate before any real crawl history exists (15s/reel)
const DEFAULT_MS_PER_REEL = 15000;

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

function slugifyFieldName(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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
app.post('/auth/logout', (req, res) => res.json({ message: 'Logged out' }));

/* --------- Handles --------- */
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

/* --------- Categories (field_name is immutable after creation) --------- */
app.get('/api/categories', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('categories')
      .where('user_id', '==', req.user.email)
      .orderBy('order', 'asc').get();
    res.json({ categories: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/categories', verifyToken, async (req, res) => {
  let { field_name, display_name, type, required, order, calculation_type, ai_prompt, formula } = req.body;
  if (!display_name || !type) {
    return res.status(400).json({ error: 'display_name, type required' });
  }
  // Internal field name defaults to a lowercase slug of the display name
  field_name = field_name ? slugifyFieldName(field_name) : slugifyFieldName(display_name);
  if (!field_name) return res.status(400).json({ error: 'Could not derive a valid field_name' });

  try {
    const existing = await db.collection('categories').doc(field_name).get();
    if (existing.exists) return res.status(409).json({ error: `A category with field_name "${field_name}" already exists` });

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
    // field_name is locked after creation — strip it even if the client sends it
    const { field_name, ...updateData } = req.body;
    await docRef.update(updateData);
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
   TAG GROUPS
   Each group defines a fixed set of tags + its own AI prompt.
   The AI must assign exactly one tag per group to each idea.
   ===================================================================== */

app.get('/api/tag-groups', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('tag_groups')
      .where('user_id', '==', req.user.email)
      .orderBy('order', 'asc').get();
    res.json({ tag_groups: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/tag-groups', verifyToken, async (req, res) => {
  const { name, ai_prompt, tags, order } = req.body;
  if (!name || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'name and a non-empty tags array are required' });
  }
  try {
    const docRef = db.collection('tag_groups').doc();
    await docRef.set({
      user_id: req.user.email,
      name,
      ai_prompt: ai_prompt || `Choose the single best-fitting tag for the "${name}" group.`,
      tags,
      order: order || 999,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ message: 'Tag group created', id: docRef.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/tag-groups/:id', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('tag_groups').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Tag group not found' });
    }
    await docRef.update(req.body);
    res.json({ message: 'Tag group updated' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/tag-groups/:id', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('tag_groups').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().user_id !== req.user.email) {
      return res.status(404).json({ error: 'Tag group not found' });
    }
    await docRef.delete();
    res.json({ message: 'Tag group deleted' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* =====================================================================
   AI HELPERS
   ===================================================================== */

async function analyzeReelWithGemini(reel, categories, tagGroups) {
  const categoryList = categories
    .filter(c => c.calculation_type !== 'mathematical')
    .map(c => `- ${c.field_name} (${c.type}): ${c.ai_prompt || c.display_name}`)
    .join('\n');

  const tagGroupInstructions = tagGroups.length
    ? tagGroups.map(g =>
        `Group "${g.name}": choose EXACTLY ONE of [${g.tags.join(', ')}]. Guidance: ${g.ai_prompt}`
      ).join('\n')
    : 'No tag groups configured — return an empty tags object.';

  const tagGroupJsonHint = tagGroups.length
    ? tagGroups.map(g => `"${g.name}": "one of: ${g.tags.join(' | ')}"`).join(', ')
    : '';

  const videoUrl = reel.media?.[0]?.url || reel.url;
  if (!videoUrl) throw new Error('No video URL found on reel');

  const videoResp = await fetch(videoUrl);
  if (!videoResp.ok) throw new Error(`Failed to download video: ${videoResp.status}`);
  const videoBuffer = Buffer.from(await videoResp.arrayBuffer());

  if (videoBuffer.length > 19 * 1024 * 1024) {
    throw new Error(`Video too large for inline analysis: ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);
  }
  const videoBase64 = videoBuffer.toString('base64');

  const promptText = `Watch this Instagram Reel video carefully.
Caption: ${reel.text || '(no caption)'}
Hashtags: ${(reel.hashtags || []).join(', ') || '(none)'}

TAG GROUPS — you must assign exactly one tag from each group:
${tagGroupInstructions}

Return ONLY valid JSON on a single line with this exact structure:
{"description": "neutral, objective description of the core concept/idea of this video (not the specific execution — the underlying reusable idea)", "production_blueprint": "how this type of video is structured, step by step, so someone could recreate the format with different content", "tags": {${tagGroupJsonHint}}, "fields": {${categoryList ? categoryList.split('\n').map(l => `// ${l}`).join(' ') : '// no AI fields configured'}}}`;

  const model = genAI.getGenerativeModel({ model: 'gemini-3.7-flash' });
  const result = await model.generateContent([
    { inlineData: { mimeType: 'video/mp4', data: videoBase64 } },
    promptText
  ]);

  const text = result.response.text() || '';

  let parsed;
  try {
    const jsonMatch = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (!jsonMatch) throw new Error('Gemini did not return valid JSON');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.log('Gemini analysis JSON parse error:', err.message, 'Response:', text.slice(0, 300));
    throw err;
  }

  // Enforce exactly one valid tag per group — drop anything that doesn't match the fixed vocabulary
  const validatedTags = {};
  for (const group of tagGroups) {
    const chosen = parsed.tags?.[group.name];
    if (chosen && group.tags.includes(chosen)) {
      validatedTags[group.name] = chosen;
    } else {
      console.log(`Tag group "${group.name}": AI returned invalid/missing tag "${chosen}", skipping.`);
    }
  }
  parsed.tags = validatedTags;
  return parsed;
}

async function generateEmbedding(text) {
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

async function findSimilarIdeas(embedding, flatTags, topK = 5) {
  const queryResult = await pineconeIndex.query({
    vector: embedding,
    topK,
    includeMetadata: true,
    filter: flatTags && flatTags.length ? { tags: { $in: flatTags } } : undefined
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
    `Reply ONLY with valid JSON on a single line: {"match": true, "idea_id": "..."} or {"match": false}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content[0]?.text || '';

  try {
    const jsonMatch = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (!jsonMatch) {
      console.log('Claude decision parse failed, no JSON found. Response:', text.slice(0, 200));
      return { match: false };
    }
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.log('Claude decision JSON parse error:', err.message, 'Response:', text.slice(0, 200));
    return { match: false };
  }
}

/* =====================================================================
   SCHEDULING LOGIC
   ===================================================================== */

const FREQUENCY_DAYS = {
  daily: 1, weekly: 7, 'bi-weekly': 14, monthly: 30, 'bi-monthly': 60
};

function isDueToday(handle) {
  if (!handle.enabled) return false;
  if (!handle.last_crawled_at) return true;
  const daysSince = (Date.now() - handle.last_crawled_at.toMillis()) / 86400000;
  return daysSince >= (FREQUENCY_DAYS[handle.frequency] || 1);
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, options);
    if ((resp.status === 502 || resp.status === 503) && attempt < maxRetries) {
      const waitMs = attempt * 2000;
      console.log(`CreatorCrawl returned ${resp.status}, retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return resp;
  }
}

/* =====================================================================
   LIVE CRAWL STATUS
   Stored in Firestore (_system/crawl_status) so it survives across
   Cloud Run instances/requests, and the frontend can poll it.
   ===================================================================== */

const STATUS_DOC = () => db.collection('_system').doc('crawl_status');
const PERF_DOC = () => db.collection('_system').doc('crawl_performance');
const MAX_STEPS_KEPT = 40;

async function getAvgMsPerReel() {
  const doc = await PERF_DOC().get();
  return doc.exists && doc.data().avg_ms_per_reel ? doc.data().avg_ms_per_reel : DEFAULT_MS_PER_REEL;
}

async function recordCrawlPerformance(totalReelsProcessed, durationMs) {
  if (totalReelsProcessed <= 0) return;
  const thisRunAvg = durationMs / totalReelsProcessed;
  const doc = await PERF_DOC().get();
  const prevAvg = doc.exists && doc.data().avg_ms_per_reel ? doc.data().avg_ms_per_reel : thisRunAvg;
  const prevSamples = doc.exists && doc.data().samples ? doc.data().samples : 0;
  // Exponential moving average — recent crawls matter more, but history still smooths outliers
  const newAvg = prevSamples === 0 ? thisRunAvg : (prevAvg * 0.7 + thisRunAvg * 0.3);
  await PERF_DOC().set({
    avg_ms_per_reel: newAvg,
    samples: prevSamples + 1,
    last_updated: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function initCrawlStatus(triggerType, handleNames) {
  await STATUS_DOC().set({
    active: true,
    trigger_type: triggerType,
    started_at: admin.firestore.FieldValue.serverTimestamp(),
    handles_total: handleNames.length,
    handles_done: 0,
    current_handle: null,
    upcoming_handles: handleNames,
    reels_known_total: 0,
    reels_done_total: 0,
    avg_ms_per_reel: await getAvgMsPerReel(),
    steps: [{ time: new Date().toISOString(), message: `Crawl gestartet (${triggerType === 'manual' ? 'manuell' : 'automatisch'}) — ${handleNames.length} Handle(s) fällig` }]
  });
}

async function pushCrawlStep(message) {
  const doc = await STATUS_DOC().get();
  const steps = doc.exists ? (doc.data().steps || []) : [];
  steps.push({ time: new Date().toISOString(), message });
  while (steps.length > MAX_STEPS_KEPT) steps.shift();
  await STATUS_DOC().update({ steps });
}

async function updateCrawlStatus(patch) {
  await STATUS_DOC().update(patch);
}

async function finishCrawlStatus() {
  await STATUS_DOC().update({
    active: false,
    finished_at: admin.firestore.FieldValue.serverTimestamp(),
    current_handle: null
  });
}

app.get('/api/crawl/status', verifyToken, async (req, res) => {
  try {
    const doc = await STATUS_DOC().get();
    if (!doc.exists) return res.json({ active: false });
    const data = doc.data();
    const remainingReels = Math.max(0, (data.reels_known_total || 0) - (data.reels_done_total || 0));
    const estimatedRemainingMs = remainingReels * (data.avg_ms_per_reel || DEFAULT_MS_PER_REEL);
    res.json({ ...data, estimated_remaining_ms: data.active ? estimatedRemainingMs : 0 });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* =====================================================================
   MAIN CRAWL PIPELINE
   ===================================================================== */

async function runCrawlForUser(userEmail, triggerType) {
  const crawlStartMs = Date.now();

  const handlesSnap = await db.collection('handles').where('user_id', '==', userEmail).get();
  const dueHandles = handlesSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isDueToday);

  const categoriesSnap = await db.collection('categories').where('user_id', '==', userEmail).get();
  const categories = categoriesSnap.docs.map(d => d.data());

  const tagGroupsSnap = await db.collection('tag_groups').where('user_id', '==', userEmail).orderBy('order', 'asc').get();
  const tagGroups = tagGroupsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  await initCrawlStatus(triggerType, dueHandles.map(h => h.handle));

  const runLog = {
    user_id: userEmail,
    trigger_type: triggerType,
    started_at: admin.firestore.FieldValue.serverTimestamp(),
    handles_processed: [],
    errors: []
  };

  let totalReelsThisRun = 0;

  for (const handle of dueHandles) {
    try {
      await updateCrawlStatus({
        current_handle: handle.handle,
        upcoming_handles: admin.firestore.FieldValue.arrayRemove(handle.handle)
      });
      await pushCrawlStep(`Lade Reels für @${handle.handle}...`);

      const ccResp = await fetchWithRetry(`${CC_BASE}/instagram/user/reels?handle=${handle.handle}`, {
        headers: { 'Authorization': `Bearer ${CREATORC_API_KEY}` }
      });

      if (!ccResp.ok) throw new Error(`CreatorCrawl API error: ${ccResp.status} ${ccResp.statusText}`);
      if (!ccResp.ok) {
  if (ccResp.status === 422) {
    // Handle doesn't exist, is private, or has no reels — treat as empty result
    await pushCrawlStep(`@${handle.handle}: nicht verarbeitbar (privat, nicht vorhanden, oder keine Reels)`);
    await updateCrawlStatus({ handles_done: admin.firestore.FieldValue.increment(1) });
    continue; // skip to next handle
  }
  throw new Error(`CreatorCrawl API error: ${ccResp.status} ${ccResp.statusText}`);
}


      const contentType = ccResp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await ccResp.text();
        throw new Error(`CreatorCrawl returned non-JSON: ${contentType} - ${text.slice(0, 100)}`);
      }

      const ccData = await ccResp.json();
      const reels = ccData.data || [];
      if (!Array.isArray(reels)) {
        throw new Error(`CreatorCrawl returned invalid reel array: ${JSON.stringify(ccData).slice(0, 100)}`);
      }

      await pushCrawlStep(`${reels.length} Reels für @${handle.handle} gefunden`);
      await updateCrawlStatus({ reels_known_total: admin.firestore.FieldValue.increment(reels.length) });

      let newCount = 0;
      for (const reel of reels) {
        try {
          const existing = await db.collection('content').doc(reel.id).get();
          if (existing.exists) {
            await updateCrawlStatus({ reels_done_total: admin.firestore.FieldValue.increment(1) });
            continue;
          }

          const analysis = await analyzeReelWithGemini(reel, categories, tagGroups);
          const flatTags = Object.values(analysis.tags || {});

          const embedding = await generateEmbedding(analysis.description);
          const candidates = await findSimilarIdeas(embedding, flatTags);
          const decision = await decideIdeaMatch(analysis.description, candidates);

          let ideaId;
          if (decision.match && decision.idea_id) {
            ideaId = decision.idea_id;
            await db.collection('ideas').doc(ideaId)
              .collection('source_reels').doc(reel.id).set({
                ...reel, analyzed_at: admin.firestore.FieldValue.serverTimestamp()
              });
            const fieldUpdate = {};
            for (const [key, value] of Object.entries(analysis.fields || {})) {
              fieldUpdate[`fields.${key}`] = value;
            }
            for (const [group, tag] of Object.entries(analysis.tags || {})) {
              fieldUpdate[`tags.${group}`] = tag;
            }
            fieldUpdate.updated_at = admin.firestore.FieldValue.serverTimestamp();
            await db.collection('ideas').doc(ideaId).update(fieldUpdate);
            await pushCrawlStep(`Reel ${reel.id.slice(0, 8)}… → bestehende Idea zugeordnet`);
          } else {
            const ideaRef = db.collection('ideas').doc();
            ideaId = ideaRef.id;
            await ideaRef.set({
              description: analysis.description,
              production_blueprint: analysis.production_blueprint,
              tags: analysis.tags || {},
              fields: analysis.fields || {},
              created_at: admin.firestore.FieldValue.serverTimestamp()
            });
            await ideaRef.collection('source_reels').doc(reel.id).set({
              ...reel, analyzed_at: admin.firestore.FieldValue.serverTimestamp()
            });
            await pineconeIndex.upsert([{
              id: ideaId,
              values: embedding,
              metadata: { description: analysis.description, tags: flatTags }
            }]);
            await pushCrawlStep(`Reel ${reel.id.slice(0, 8)}… → neue Idea erstellt`);
          }

          await db.collection('content').doc(reel.id).set({
            user_id: userEmail,
            source_handle: handle.handle,
            idea_id: ideaId,
            ...reel,
            created_at: admin.firestore.FieldValue.serverTimestamp()
          });

          newCount++;
          totalReelsThisRun++;
          await updateCrawlStatus({ reels_done_total: admin.firestore.FieldValue.increment(1) });
        } catch (reelErr) {
          console.error(`Error processing reel ${reel?.id}:`, reelErr.message);
          await updateCrawlStatus({ reels_done_total: admin.firestore.FieldValue.increment(1) });
          totalReelsThisRun++;
        }
      }

      await db.collection('handles').doc(handle.id).update({
        last_crawled_at: admin.firestore.FieldValue.serverTimestamp()
      });

      await pushCrawlStep(`@${handle.handle} fertig — ${newCount} neue Reels`);
      await updateCrawlStatus({ handles_done: admin.firestore.FieldValue.increment(1) });
      runLog.handles_processed.push({ handle: handle.handle, new_reels: newCount });
    } catch (handleErr) {
      console.error(`Error crawling @${handle.handle}:`, handleErr.message);
      await pushCrawlStep(`Fehler bei @${handle.handle}: ${handleErr.message}`);
      await updateCrawlStatus({ handles_done: admin.firestore.FieldValue.increment(1) });
      runLog.errors.push({ handle: handle.handle, error: handleErr.message });
    }
  }

  runLog.finished_at = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('ai_runs').add(runLog);

  await pushCrawlStep('Crawl abgeschlossen');
  await finishCrawlStatus();

  const durationMs = Date.now() - crawlStartMs;
  await recordCrawlPerformance(totalReelsThisRun, durationMs);

  return runLog;
}

app.post('/api/crawl/run', verifySchedulerSecret, async (req, res) => {
  try {
    const result = await runCrawlForUser(SHARED_EMAIL, 'automatic');
    res.json({ message: 'Crawl complete', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/crawl/run-now', verifyToken, async (req, res) => {
  try {
    const result = await runCrawlForUser(req.user.email, 'manual');
    res.json({ message: 'Crawl complete', result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ideas/test-match', verifyToken, async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  try {
    const embedding = await generateEmbedding(description);
    const candidates = await findSimilarIdeas(embedding, undefined, 5);
    const enriched = await Promise.all(candidates.map(async (c) => {
      const doc = await db.collection('ideas').doc(c.id).get();
      return {
        id: c.id,
        similarity_score: c.score,
        description: doc.exists ? doc.data().description : (c.metadata?.description || null),
        tags: doc.exists ? doc.data().tags : {}
      };
    }));
    const decision = await decideIdeaMatch(description, candidates);
    res.json({ candidates: enriched, decision });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* --------- Ideas --------- */
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

/* --------- Content --------- */
app.get('/api/content', verifyToken, async (req, res) => {
  try {
    let query = db.collection('content').where('user_id', '==', req.user.email);
    if (req.query.handle) query = query.where('source_handle', '==', req.query.handle);
    const snap = await query.orderBy('created_at', 'desc').limit(100).get();
    res.json({ content: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* --------- Dashboard --------- */
app.get('/api/dashboard', verifyToken, async (req, res) => {
  try {
    const handlesSnap = await db.collection('handles').where('user_id', '==', req.user.email).get();
    const contentSnap = await db.collection('content')
      .where('user_id', '==', req.user.email).orderBy('created_at', 'desc').limit(10).get();
    const runsSnap = await db.collection('ai_runs')
      .where('user_id', '==', req.user.email).orderBy('started_at', 'desc').limit(10).get();
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
app.listen(PORT, () => console.log(`Creator Crawl Phase 5 backend listening on port ${PORT}`));
