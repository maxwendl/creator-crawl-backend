/* =====================================================================
   Creator Crawl Backend — Node.js Express server
   Runs on Google Cloud Run
   ===================================================================== */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS env var)
try {
  admin.initializeApp();
} catch (e) {
  console.log('Firebase already initialized');
}
const db = admin.firestore();
const secretManager = admin.secretManager?.v1 || null;

// Config from environment
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

/* --------- Auth endpoints --------- */
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  // Simple shared auth
  if (email === SHARED_EMAIL && password === SHARED_PASSWORD) {
    const token = jwt.sign({ email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, email });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req, res) => {
  // Token is invalidated on client (can't revoke JWTs easily, but they expire)
  res.json({ message: 'Logged out' });
});

/* --------- CreatorCrawl API wrapper (private, uses stored key) --------- */
async function ccFetch(path, params = {}) {
  const url = new URL(CC_BASE + path);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  
  const resp = await fetch(url.toString(), {
    headers: { 'x-api-key': CREATORC_API_KEY },
  });
  if (!resp.ok) throw new Error(`CreatorCrawl ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

/* --------- Crawl endpoints --------- */
app.post('/api/crawl', verifyToken, async (req, res) => {
  const { input, limit = 12 } = req.body;
  if (!input) return res.status(400).json({ error: 'input required' });
  
  try {
    const isUrl = /instagram\.com\/(p|reel)\//.test(input);
    let reels = [];
    
    if (isUrl) {
      // Single post
      const data = await ccFetch('/instagram/post', { url: input });
      reels = [data?.data?.[0] || data];
    } else {
      // Profile
      const handle = input.replace(/^@/, '').trim();
      const data = await ccFetch('/instagram/user/reels', { handle });
      reels = (data.data || data.items || []).slice(0, limit);
    }
    
    res.json({ reels, count: reels.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Save reel to Firestore --------- */
app.post('/api/reel/save', verifyToken, async (req, res) => {
  const { id, owner, caption, videoUrl, thumb, stats } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  
  try {
    await db.collection('reels').doc(id).set({
      id,
      owner,
      caption,
      videoUrl,
      thumb,
      playCount: stats?.playCount || 0,
      likeCount: stats?.likeCount || 0,
      commentCount: stats?.commentCount || 0,
      description: '', // empty until AI analyzes
      savedAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: req.user.email,
      analyzed: false,
    }, { merge: true });
    
    res.json({ message: 'Reel saved', id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- List saved reels --------- */
app.get('/api/reels', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('reels')
      .where('userId', '==', req.user.email)
      .orderBy('savedAt', 'desc')
      .limit(100)
      .get();
    
    const reels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ reels });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Schedule: set crawl frequency per user --------- */
app.post('/api/schedule/set', verifyToken, async (req, res) => {
  const { handle, frequency } = req.body; // frequency: "daily", "weekly", "biweekly", "monthly", etc.
  if (!handle || !frequency) return res.status(400).json({ error: 'handle and frequency required' });
  
  try {
    await db.collection('schedules').doc(req.user.email).set({
      handles: {
        [handle]: {
          frequency,
          lastCrawledAt: admin.firestore.FieldValue.serverTimestamp(),
          enabled: true,
        },
      },
    }, { merge: true });
    
    res.json({ message: 'Schedule saved', handle, frequency });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Get user's schedules --------- */
app.get('/api/schedule/list', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('schedules').doc(req.user.email).get();
    const schedules = doc.exists ? doc.data().handles || {} : {};
    res.json({ schedules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------- Analyze reel with Hugging Face --------- */
async function analyzeWithHF(videoUrl) {
  if (!HF_API_KEY) return 'No HF key configured';
  
  try {
    // This assumes HF has a video-to-text model. You might use a different endpoint.
    // For now, just return placeholder — we'll wire this up properly.
    return 'Video analysis would run here (HF integration TBD)';
  } catch (err) {
    console.error('HF error:', err);
    return 'Analysis failed';
  }
}

/* --------- Health check --------- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Creator Crawl backend listening on port ${PORT}`);
});
