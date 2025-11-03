// server.js
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

/* -------------------- Setup -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static('.')); // Serve static files (index.html, etc.)

const PORT = process.env.PORT || 8080;

/* -------------------- "Database" (JSON file) -------------------- */
/**
 * We keep everything in memory for speed and autosave to ./data/data.json
 * Shape:
 * {
 *   users: [{ id, email, name, passHash, age, dob, createdAt }],
 *   profiles: { userId: { height, weight, foot, position, dob, updatedAt } },
 *   clipsByUser: { userId: [ { url, public_id, created_at, bytes, duration, width, height, format } ] },
 *   analysesByUser: { userId: [ { id, summary, focus[], drills[], comps[], video_url, created_at } ] }  // (array after migration)
 * }
 */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],                // [{ id, email, name, passHash, age, dob, createdAt }]
  profiles: {},             // { userId: { height (inches), weight (lbs), foot, position, dob, updatedAt } }
  clipsByUser: {},          // { userId: [ { url, public_id, created_at, ... } ] }
  analysesByUser: {}        // { userId: [ { ...analysisItem } ] }  (array after migration)
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        db.users = Array.isArray(parsed.users) ? parsed.users : [];
        db.profiles = parsed.profiles || {};
        db.clipsByUser = parsed.clipsByUser || {};
        db.analysesByUser = parsed.analysesByUser || {};
        console.log('[BK] DB loaded:', {
          users: db.users.length,
          withProfiles: Object.keys(db.profiles).length,
          withClips: Object.keys(db.clipsByUser).length,
          withAnalyses: Object.keys(db.analysesByUser).length
        });
      }
    } else {
      console.log('[BK] No existing DB, creating new one');
      saveDB(true);
    }
  } catch (e) {
    console.error('[BK] Failed to load DB, starting fresh:', e);
    saveDB(true);
  }
}

let saveTimer = null;
function saveDB(immediate = false) {
  try {
    ensureDataDir();
    const write = () =>
      fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');

    if (immediate) {
      write();
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    // debounce disk writes (reduce churn if many updates happen quickly)
    saveTimer = setTimeout(() => {
      try {
        write();
      } catch (e) {
        console.error('[BK] Save DB error:', e);
      }
      saveTimer = null;
    }, 400);
  } catch (e) {
    console.error('[BK] Save DB setup error:', e);
  }
}

loadDB();

/* -------------------- Helpers -------------------- */
function findUser(email) {
  return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
}

function findUserById(id) {
  return db.users.find(u => u.id === id);
}
// ---- analyses helpers ----
function ensureUserAnalyses(userId) {
  if (!Array.isArray(db.analysesByUser[userId])) db.analysesByUser[userId] = [];
  return db.analysesByUser[userId];
}
function getAnalysis(userId, id) {
  const arr = ensureUserAnalyses(userId);
  return arr.find(a => a.id === id) || null;
}

// NEW: ensure an array store exists for a given key on an object
function ensureArrayStore(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

/* -------- Migration: convert any single analysis object to array -------- */
for (const uid of Object.keys(db.analysesByUser || {})) {
  const v = db.analysesByUser[uid];
  if (v && !Array.isArray(v)) {
    db.analysesByUser[uid] = [{ id: uuidv4(), ...v }];
  }
}
saveDB();

/* -------------------- Auth Middleware -------------------- */
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

/* -------------------- Routes -------------------- */

// Root + health
app.get('/', (_req, res) => {
  res.send('ai-soccer-backend is running ✅');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, age, dob } = req.body || {};
    
    if (!name || !email || !password || !age || !dob) {
      return res.status(400).json({ ok: false, error: 'All fields required' });
    }
    
    if (findUser(email)) {
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    }

    const id = uuidv4();
    const passHash = await bcrypt.hash(String(password), 10);
    
    const user = {
      id,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      passHash,
      age: Number(age),
      dob: String(dob).trim(),
      createdAt: Date.now()
    };
    
    db.users.push(user);
    saveDB();

    const token = jwt.sign({ sub: id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, user: { id, name: user.name, email: user.email } });
  } catch (e) {
    console.error('[BK] Signup error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required' });
    }
    
    const user = findUser(email);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }
    
    const match = await bcrypt.compare(String(password), user.passHash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error('[BK] Login error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Get current user
app.get('/api/me', auth, (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
});

// Get profile (+ clips + latest analysis)
app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
    clips: db.clipsByUser[req.userId] || [],
    analysis: Array.isArray(db.analysesByUser[req.userId])
      ? db.analysesByUser[req.userId][0] || null
      : db.analysesByUser[req.userId] || null
  });
});

/* -------- shared profile upsert (used by POST + PUT) -------- */
function upsertProfile(userId, body) {
  const { height, weight, foot, position, dob } = body || {};
  db.profiles[userId] = {
    ...(db.profiles[userId] || {}),
    height: height ? Number(height) : db.profiles[userId]?.height ?? null,
    weight: weight ? Number(weight) : db.profiles[userId]?.weight ?? null,
    foot: (foot ?? db.profiles[userId]?.foot) ?? null,
    position: (position ?? db.profiles[userId]?.position) ?? null,
    dob: (dob ?? db.profiles[userId]?.dob) ?? null,
    updatedAt: Date.now()
  };
  saveDB();
  return db.profiles[userId];
}

// PUT profile (new)
app.put('/api/profile', auth, (req, res) => {
  const profile = upsertProfile(req.userId, req.body);
  res.json({ ok: true, profile });
});

// POST profile (kept for compatibility)
app.post('/api/profile', auth, (req, res) => {
  const profile = upsertProfile(req.userId, req.body);
  res.json({ ok: true, profile });
});

// Add clip metadata
app.post('/api/clip', auth, (req, res) => {
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  
  if (!url && !public_id) {
    return res.status(400).json({ ok: false, error: 'url or public_id required' });
  }

  const list = ensureArrayStore(db.clipsByUser, req.userId);
  
  const clip = {
    url: url || null,
    public_id: public_id || null,
    created_at: created_at || new Date().toISOString(),
    bytes: Number(bytes) || null,
    duration: Number(duration) || null,
    width: Number(width) || null,
    height: Number(height) || null,
    format: format || null
  };
  
  list.unshift(clip);
  saveDB();
  
  res.json({ ok: true, clip, total: list.length });
});

// Analyze (mock AI) — returns an improved dynamic analysis
app.post('/api/analyze', auth, (req, res) => {
  try {
    const { height, weight, foot, position, videoUrl } = req.body || {};

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Video URL required' });
    }

    // Update profile with submitted attributes
    if (height || weight || foot || position) {
      db.profiles[req.userId] = {
        ...(db.profiles[req.userId] || {}),
        height: height ? Number(height) : db.profiles[req.userId]?.height,
        weight: weight ? Number(weight) : db.profiles[req.userId]?.weight,
        foot: foot || db.profiles[req.userId]?.foot,
        position: position || db.profiles[req.userId]?.position,
        updatedAt: Date.now()
      };
    }
    // === Library: list all analyses (latest first)
app.get('/api/analyses', auth, (req, res) => {
  const arr = ensureUserAnalyses(req.userId).slice().sort((a,b) => b.created_at - a.created_at);
  res.json({ ok: true, items: arr });
});

// === Library: fetch one analysis by id
app.get('/api/analyses/:id', auth, (req, res) => {
  const a = getAnalysis(req.userId, req.params.id);
  if (!a) return res.status(404).json({ ok:false, error:'Not found' });
  res.json({ ok:true, item:a });
});

// === Library: create/save an analysis item
app.post('/api/analyses', auth, (req, res) => {
  const {
    summary, focus, drills, comps,
    videoUrl, publicId,
    height, weight, foot, position,
    raw
  } = req.body || {};

  const id = uuidv4();
  const item = {
    id,
    summary: summary || '',
    focus: Array.isArray(focus) ? focus : [],
    drills: Array.isArray(drills) ? drills : [],
    comps: Array.isArray(comps) ? comps : [],
    video_url: videoUrl || null,
    public_id: publicId || null,
    height: Number(height) || null,
    weight: Number(weight) || null,
    foot: foot || null,
    position: position || null,
    raw: raw || null,
    created_at: Date.now()
  };

  const arr = ensureUserAnalyses(req.userId);
  arr.unshift(item);
  saveDB();

  res.json({ ok:true, item });
});

// === Library: delete an analysis by id
app.delete('/api/analyses/:id', auth, (req, res) => {
  const arr = ensureUserAnalyses(req.userId);
  const idx = arr.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok:false, error:'Not found' });
  const [removed] = arr.splice(idx, 1);
  saveDB();
  res.json({ ok:true, removedId: removed.id });
});

    // Generate more personalized analysis output
    const analysis = {
      summary: generateDynamicSummary({ height, weight, foot, position }),
      focus: generateFocusAreas({ foot, position }),
      drills: generateDrills({ position }),
      comps: generateComps({ position }),
      videoUrl,
      createdAt: Date.now()
    };

    db.analysesByUser[req.userId] = analysis;
    saveDB();

    res.json({ ok: true, ...analysis });
  } catch (e) {
    console.error('[BK] Analyze error:', e);
    res.status(500).json({ ok: false, error: 'Analysis failed' });
  }
});

// === Helper functions for dynamic analysis === //
function generateDynamicSummary({ height, weight, foot, position }) {
  const pos = position || 'player';
  const footDesc = foot ? `${foot.toLowerCase()}-footed` : '';
  return `As a ${footDesc} ${pos}, you show strong technical balance. Your physical profile (${height || '?'} in / ${weight || '?'} lbs) supports your positional demands. Key strengths observed with room for refinement.`;
}

function generateFocusAreas({ foot, position }) {
  const base = [
    'First touch consistency under pressure',
    'Off-ball movement timing',
    'Defensive transition awareness'
  ];
  if (foot && foot.toLowerCase() !== 'both') {
    base.push('Improve weak-foot control and passing range');
  }
  if (position?.toLowerCase().includes('mid')) {
    base.push('Increase scanning frequency before receiving');
  }
  if (position?.toLowerCase().includes('wing')) {
    base.push('Work on final-third decision-making and crossing');
  }
  if (position?.toLowerCase().includes('def')) {
    base.push('Improve line coordination and tackle timing');
  }
  return base;
}

function generateDrills({ position }) {
  const drills = [
    { title: 'Rondo 4v2 (High Intensity)', url: 'https://www.youtube.com/watch?v=example1' },
    { title: 'Weak Foot Finishing (100 reps)', url: 'https://www.youtube.com/watch?v=example2' },
    { title: '1v1 Pressing Transitions', url: 'https://www.youtube.com/watch?v=example3' },
    { title: 'Shadow Play Pattern Recognition', url: 'https://www.youtube.com/watch?v=example4' }
  ];
  if (position?.toLowerCase().includes('wing')) {
    drills.unshift({ title: 'Crossing Accuracy + Speed Drill', url: 'https://www.youtube.com/watch?v=example5' });
  }
  if (position?.toLowerCase().includes('mid')) {
    drills.unshift({ title: 'Vision & Passing Triangle Drill', url: 'https://www.youtube.com/watch?v=example6' });
  }
  if (position?.toLowerCase().includes('def')) {
    drills.unshift({ title: '1v1 Defending Under Pressure', url: 'https://www.youtube.com/watch?v=example7' });
  }
  return drills.slice(0, 4);
}

function generateComps({ position }) {
  if (position?.toLowerCase().includes('wing')) return ['Bukayo Saka', 'Leroy Sané', 'Marcus Rashford'];
  if (position?.toLowerCase().includes('mid')) return ['Kevin De Bruyne', 'Phil Foden', 'Pedri'];
  if (position?.toLowerCase().includes('def')) return ['Virgil van Dijk', 'Ruben Dias', 'John Stones'];
  if (position?.toLowerCase().includes('striker')) return ['Erling Haaland', 'Kylian Mbappé', 'Harry Kane'];
  return ['Luka Modrić', 'Jude Bellingham', 'Rodri'];
}
/* -------------------- NEW: Library save/list routes -------------------- */

// Save an analysis item (called by frontend after Analyze completes)
app.post('/api/analyses', auth, (req, res) => {
  try {
    const {
      height, weight, foot, position, videoUrl,
      summary, focus, drills, comps, raw
    } = req.body || {};

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Missing videoUrl' });
    }

    // Ensure the user has an array store
    const arr = ensureArrayStore(db.analysesByUser, req.userId);

    const item = {
      id: uuidv4(),
      height: height ? Number(height) : null,
      weight: weight ? Number(weight) : null,
      foot: foot || null,
      position: position || null,
      video_url: videoUrl,               // snake_case for consistency with UI
      summary: summary || null,
      focus: Array.isArray(focus) ? focus : (focus ? [focus] : []),
      drills: Array.isArray(drills) ? drills : [],
      comps: Array.isArray(comps) ? comps : [],
      raw: raw || null,
      created_at: new Date().toISOString()
    };

    // newest first
    arr.unshift(item);
    saveDB();

    res.json({ ok: true, id: item.id });
  } catch (e) {
    console.error('[BK] Save analysis error:', e);
    res.status(500).json({ ok: false, error: 'Save failed' });
  }
});

// List analyses (Library)
app.get('/api/analyses', auth, (req, res) => {
  const items = Array.isArray(db.analysesByUser[req.userId])
    ? db.analysesByUser[req.userId]
    : [];
  res.json({ ok: true, items });
});

/* -------------------- Start -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on port ${PORT}`);
});

