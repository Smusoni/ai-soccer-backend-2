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
app.use(express.json({ limit: '25mb' })); // allow JSON bodies

const PORT = process.env.PORT || 8080;

/* -------------------- "Database" (JSON file) -------------------- */
/**
 * We keep everything in memory for speed and autosave to ./data/data.json
 * Shape:
 * {
 *   players: ["Syd", "Carson"],
 *   attrsByPlayer: {
 *     "Syd": { pace: 80, tech: 75, aware: 90, comp: 82, savedAt: 1730... }
 *   },
 *   clipsByPlayer: {
 *     "Syd": [ { url, public_id, created_at, bytes, duration, width, height, format } ]
 *   }
 * }
 */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  // legacy “players” (keep for now so your current UI still works)
  players: [],
  attrsByPlayer: {},
  clipsByPlayer: {},

  // NEW: accounts + profiles
  users: [],                // [{ id, username, passHash, createdAt }]
  profiles: {},             // { userId: { height, weight, foot, position, updatedAt } }
  clipsByUser: {},          // { userId: [ { url, public_id, created_at, ... } ] }
  analysesByUser: {}        // { userId: { summary, topSkill, needsWork, drills[], comps[] , createdAt } }
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
        db.players = Array.isArray(parsed.players) ? parsed.players : [];
        db.attrsByPlayer = parsed.attrsByPlayer || {};
        db.clipsByPlayer = parsed.clipsByPlayer || {};
        console.log('[BK] DB loaded:', {
          players: db.players.length,
          withAttrs: Object.keys(db.attrsByPlayer).length,
          withClips: Object.keys(db.clipsByPlayer).length
        });
      }
    } else {
      saveDB(true);
    }
  } catch (e) {
    console.error('[BK] Failed to load DB, starting fresh:', e);
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
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim();
}

function ensurePlayer(name) {
  const n = normalizeName(name);
  if (!n) return null;
  if (!db.players.includes(n)) db.players.push(n);
  if (!db.attrsByPlayer[n]) db.attrsByPlayer[n] = {};
  if (!db.clipsByPlayer[n]) db.clipsByPlayer[n] = [];
  return n;
}

function clamp01to100(v, fallback = 0) {
  const num = Number(v);
  if (Number.isNaN(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}
// --- helpers: coerce profile values ---
function normalizeProfile(body = {}) {
  const toInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');

  const height = toInt(body.height);     // centimeters or inches — you choose
  const weight = toInt(body.weight);     // lbs or kg — you choose
  const foot    = cleanStr(body.foot);   // 'left' | 'right' | 'both'
  const position= cleanStr(body.position);
  const dob     = cleanStr(body.dob);    // 'YYYY-MM-DD' (optional)

  return { height, weight, foot, position, dob };
}
/* -------------------- Auth helpers -------------------- */
function findUser(username) {
  return db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
}

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
// Save / update profile
app.post('/api/profile', auth, (req, res) => {
  const { height, weight, foot, position } = req.body || {};
  db.profiles[req.userId] = {
    height: Number(height) || null,
    weight: Number(weight) || null,
    foot: foot || null,           // "Left" | "Right" | "Both"
    position: position || null,   // e.g., "ST", "CAM", "LB", ...
    updatedAt: Date.now()
  };
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

// Add a clip (metadata only; Cloudinary upload is front-end)
app.post('/api/clip', auth, (req, res) => {
  const {
    url, public_id, created_at, bytes, duration, width, height, format
  } = req.body || {};
  if (!url && !public_id) return res.status(400).json({ ok:false, error:'url or public_id required' });

  if (!Array.isArray(db.clipsByUser[req.userId])) db.clipsByUser[req.userId] = [];
  const clip = {
    url: url || null, public_id: public_id || null,
    created_at: created_at || new Date().toISOString(),
    bytes: Number(bytes) || null, duration: Number(duration) || null,
    width: Number(width) || null, height: Number(height) || null,
    format: format || null
  };
  db.clipsByUser[req.userId].unshift(clip);
  saveDB();
  res.json({ ok: true, clip, total: db.clipsByUser[req.userId].length });
});

// Get my full profile (profile + clips + last analysis)
app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
    clips: db.clipsByUser[req.userId] || [],
    analysis: db.analysesByUser[req.userId] || null
  });
});

// Analyze (MVP mock returning structured report)
app.post('/api/analyze', auth, (req, res) => {
  // In future: use last clip + profile to run real model
  const prof = db.profiles[req.userId] || {};
  const clip = (db.clipsByUser[req.userId] || [])[0] || null;

  const report = {
    summary: 'Solid base. Good pace; work on decision speed.',
    topSkill: 'Pace & Scanning',
    needsWork: 'Composure under pressure',
    drills: [
      'Small-space reaction training (3× per week)',
      'Wall passing (weak foot) 100 reps',
      '1v1 transition drill 10 reps'
    ],
    comps: ['Bukayo Saka (style)', 'Leroy Sané (tendencies)'],
    usedClip: clip?.public_id || clip?.url || null,
    usedProfile: { foot: prof.foot, position: prof.position },
    createdAt: Date.now()
  };

  db.analysesByUser[req.userId] = report;
  saveDB();
  res.json({ ok: true, report });
});

/* -------------------- Routes -------------------- */

// Root + health
app.get('/', (_req, res) => {
  res.send('ai-soccer-backend is running ✅');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Add a player
app.post('/api/player', (req, res) => {
  const { name } = req.body || {};
  const n = ensurePlayer(name);
  if (!n) {
    return res.status(400).json({ ok: false, error: 'Name is required' });
  }
  saveDB();
  return res.json({ ok: true, message: `${n} added!`, players: db.players });
});

// Get all players
app.get('/api/players', (_req, res) => {
  res.json({ ok: true, players: db.players });
});

// Save attributes (pace, tech, aware, comp are 0..100)
app.post('/api/player/:name/attrs', (req, res) => {
  const n = ensurePlayer(req.params.name);
  if (!n) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const { pace = 0, tech = 0, aware = 0, comp = 0 } = req.body || {};

  db.attrsByPlayer[n] = {
    pace: clamp01to100(pace),
    tech: clamp01to100(tech),
    aware: clamp01to100(aware),
    comp: clamp01to100(comp),
    savedAt: Date.now()
  };

  saveDB();
  res.json({ ok: true, saved: db.attrsByPlayer[n] });
});

// Get one player profile (name + attributes + clips)
app.get('/api/player/:name', (req, res) => {
  const n = normalizeName(req.params.name);
  if (!n) return res.status(400).json({ ok: false, error: 'Invalid name' });

  const attributes = db.attrsByPlayer[n] || {};
  const clips = db.clipsByPlayer[n] || [];

  res.json({
    ok: true,
    name: n,
    attributes,
    clips
  });
});

// Save a video clip metadata after Cloudinary upload
app.post('/api/player/:name/clip', (req, res) => {
  const n = ensurePlayer(req.params.name);
  if (!n) return res.status(400).json({ ok: false, error: 'Invalid name' });

  // Expect body with at least url or public_id
  const {
    url,
    public_id,
    created_at,
    bytes,
    duration,
    width,
    height,
    format
  } = req.body || {};

  if (!url && !public_id) {
    return res.status(400).json({ ok: false, error: 'url or public_id required' });
  }

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

  if (!Array.isArray(db.clipsByPlayer[n])) db.clipsByPlayer[n] = [];
  db.clipsByPlayer[n].push(clip);
  saveDB();

  res.json({ ok: true, saved: clip, totalClips: db.clipsByPlayer[n].length });
});
// --- Signup ---
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });
  if (findUser(username)) return res.status(409).json({ ok: false, error: 'username taken' });

  const id = uuidv4();
  const passHash = await bcrypt.hash(String(password), 10);
  db.users.push({ id, username, passHash, createdAt: Date.now() });
  saveDB();

  const token = jwt.sign({ sub: id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, user: { id, username } });
});

// --- Login ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser(username);
  if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' });
  const ok = await bcrypt.compare(String(password), user.passHash);
  if (!ok) return res.status(401).json({ ok: false, error: 'invalid credentials' });

  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, user: { id: user.id, username: user.username } });
});

// --- Me ---
app.get('/api/me', auth, (req, res) => {
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});
// --- Profile: save ---
app.post('/api/profile', auth, (req, res) => {
  try {
    const userId = req.userId || (req.user && req.user.id);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const profile = {
      height: req.body.height,
      weight: req.body.weight,
      foot: req.body.foot,
      position: req.body.position,
      dob: req.body.dob,
      updatedAt: Date.now(),
    };

    db.profiles[userId] = { ...(db.profiles[userId] || {}), ...profile };
    saveDB();

    return res.json({ ok: true, profile: db.profiles[userId] });
  } catch (e) {
    console.error('[BK] profile save error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// --- Profile: fetch ---
app.get('/api/profile', auth, (req, res) => {
  try {
    const userId = req.userId || (req.user && req.user.id);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const profile = db.profiles[userId] || null;
    res.json({ ok: true, profile });
  } catch (e) {
    console.error('[BK] profile get error:', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// Get my profile
app.get('/api/profile', auth, (req, res) => {
  const p = db.profiles[req.userId] || null;
  res.json({ ok: true, profile: p });
});

// Create/Update my profile
app.post('/api/profile', auth, (req, res) => {
  const { height, weight, foot, position, dob } = req.body || {};
  if (!dob) {
    // expect 'YYYY-MM-DD' from the client
    return res.status(400).json({ ok:false, error:'dob is required (YYYY-MM-DD)' });
  }
  db.profiles[req.userId] = {
    ...(db.profiles[req.userId] || {}),
    height, weight, foot, position, dob,
    updatedAt: Date.now(),
  };
  saveDB();
  res.json({ ok:true, profile: db.profiles[req.userId] });
});

// Optional helper to compute age on the fly
app.get('/api/profile/age', auth, (req, res) => {
  const p = db.profiles[req.userId];
  if (!p || !p.dob) return res.status(404).json({ ok:false, error:'no dob' });
  const today = new Date();
  const [y, m, d] = p.dob.split('-').map(Number);
  let age = today.getFullYear() - y;
  const md = (today.getMonth()+1) * 100 + today.getDate();
  const mdDob = m*100 + d;
  if (md < mdDob) age--;
  res.json({ ok:true, age });
});

/* -------------------- Start -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on port ${PORT}`);
});
