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

/* ---------- Tight CORS (GitHub Pages + localhost) ---------- */
const ALLOWED_ORIGINS = new Set([
  'https://smusoni.github.io',           // your GitHub Pages site
  'http://localhost:5173',               // Vite (if you use it locally)
  'http://localhost:8080',               // this server locally
  'http://127.0.0.1:8080',
]);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // curl / same-origin
    cb(null, ALLOWED_ORIGINS.has(origin));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));

// Preflight helper (some hosts can be picky)
app.options('*', cors());

/* ---------- Basic security headers (no extra deps) ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static('.', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Cache static assets (not API)
    if (/\.(css|js|png|jpg|jpeg|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

const PORT = process.env.PORT || 8080;

/* -------------------- "Database" (JSON file) -------------------- */
/**
 * We keep everything in memory for speed and autosave to ./data/data.json
 * Shape:
 * {
 *   users: [{ id, email, name, passHash, age, dob, createdAt }],
 *   profiles: { [userId]: { height, weight, foot, position, dob, updatedAt } },
 *   clipsByUser: { [userId]: [ { url, public_id, created_at, ... } ] },
 *   analysesByUser: { [userId]: [ { id, summary, focus[], drills[], comps[], video_url, created_at } ] }
 * }
 */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],
  profiles: {},
  clipsByUser: {},
  analysesByUser: {},   // NOTE: now stores an *array* per user (library)
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
        db.users          = Array.isArray(parsed.users) ? parsed.users : [];
        db.profiles       = parsed.profiles || {};
        db.clipsByUser    = parsed.clipsByUser || {};
        // migrate single analysi(s) into arrays if older format existed
        if (parsed.analysesByUser) {
          db.analysesByUser = {};
          for (const [uid, value] of Object.entries(parsed.analysesByUser)) {
            db.analysesByUser[uid] = Array.isArray(value) ? value : (value ? [value] : []);
          }
        }
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
    saveTimer = setTimeout(() => {
      try { write(); } catch (e) { console.error('[BK] Save DB error:', e); }
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
app.get('/', (_req, res) => { res.send('ai-soccer-backend is running ✅'); });
app.get('/api/health', (_req, res) => { res.json({ ok: true, uptime: process.uptime() }); });

/* ---------- Auth ---------- */
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

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required' });
    }
    const user = findUser(email);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const match = await bcrypt.compare(String(password), user.passHash);
    if (!match) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error('[BK] Login error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/me', auth, (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
});

/* ---------- Profile ---------- */
app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
    clips: db.clipsByUser[req.userId] || [],
  });
});

app.post('/api/profile', auth, (req, res) => {
  const { height, weight, foot, position, dob } = req.body || {};
  db.profiles[req.userId] = {
    ...(db.profiles[req.userId] || {}),
    height: height ? Number(height) : db.profiles[req.userId]?.height ?? null,
    weight: weight ? Number(weight) : db.profiles[req.userId]?.weight ?? null,
    foot: foot ?? db.profiles[req.userId]?.foot ?? null,
    position: position ?? db.profiles[req.userId]?.position ?? null,
    dob: dob ?? db.profiles[req.userId]?.dob ?? null,
    updatedAt: Date.now()
  };
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

// PUT also supported (frontend may use it)
app.put('/api/profile', auth, (req, res) => {
  const { name, height, weight, foot, position, dob, age } = req.body || {};
  const u = findUserById(req.userId);
  if (u && name) u.name = String(name).trim();
  if (u && typeof age !== 'undefined') u.age = Number(age);
  db.profiles[req.userId] = {
    ...(db.profiles[req.userId] || {}),
    height: typeof height !== 'undefined' ? Number(height) : db.profiles[req.userId]?.height ?? null,
    weight: typeof weight !== 'undefined' ? Number(weight) : db.profiles[req.userId]?.weight ?? null,
    foot: typeof foot !== 'undefined' ? foot : db.profiles[req.userId]?.foot ?? null,
    position: typeof position !== 'undefined' ? position : db.profiles[req.userId]?.position ?? null,
    dob: typeof dob !== 'undefined' ? dob : db.profiles[req.userId]?.dob ?? null,
    updatedAt: Date.now(),
  };
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

/* ---------- Clips (metadata only) ---------- */
app.post('/api/clip', auth, (req, res) => {
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  if (!url && !public_id) return res.status(400).json({ ok: false, error: 'url or public_id required' });
  if (!Array.isArray(db.clipsByUser[req.userId])) db.clipsByUser[req.userId] = [];
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
  db.clipsByUser[req.userId].unshift(clip);
  saveDB();
  res.json({ ok: true, clip, total: db.clipsByUser[req.userId].length });
});

/* ---------- Library: analyses ---------- */
// create
app.post('/api/analyses', auth, (req, res) => {
  const { summary, focus, drills, comps, videoUrl } = req.body || {};
  const item = {
    id: uuidv4(),
    summary: summary || '',
    focus: Array.isArray(focus) ? focus : [],
    drills: Array.isArray(drills) ? drills : [],
    comps: Array.isArray(comps) ? comps : [],
    video_url: videoUrl || null,
    created_at: new Date().toISOString(),
  };
  if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
  db.analysesByUser[req.userId].unshift(item);
  saveDB();
  res.json({ ok: true, id: item.id });
});

// list
app.get('/api/analyses', auth, (req, res) => {
  res.json({ ok: true, items: db.analysesByUser[req.userId] || [] });
});

// get one
app.get('/api/analyses/:id', auth, (req, res) => {
  const list = db.analysesByUser[req.userId] || [];
  const item = list.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, item });
});

// delete
app.delete('/api/analyses/:id', auth, (req, res) => {
  const list = db.analysesByUser[req.userId] || [];
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  list.splice(idx, 1);
  db.analysesByUser[req.userId] = list;
  saveDB();
  res.json({ ok: true });
});

/* ---------- Analyze (mock AI) ---------- */
app.post('/api/analyze', auth, (req, res) => {
  try {
    const { height, weight, foot, position, videoUrl } = req.body || {};
    if (!videoUrl) return res.status(400).json({ ok: false, error: 'Video URL required' });

    // Update profile if provided
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

    // Mock result (replace later with real model)
    const analysis = {
      summary: `As a ${foot ? foot.toLowerCase() + '-footed ' : ''}${position || 'player'}, you show strong technical balance. Your physical profile (${height ? `${height} in` : '—'} / ${weight ? `${weight} lbs` : '—'}) supports your positional demands. Key strengths observed with room for refinement.`,
      focus: [
        'First touch consistency under pressure',
        'Off-ball movement timing',
        'Weak foot development',
        'Defensive transition speed'
      ],
      drills: [
        { title: 'Rondo 4v2 (High Intensity)', url: 'https://www.youtube.com/watch?v=example1' },
        { title: 'Weak Foot Finishing (100 reps)', url: 'https://www.youtube.com/watch?v=example2' },
        { title: '1v1 Pressing Transitions', url: 'https://www.youtube.com/watch?v=example3' },
        { title: 'Shadow Play Pattern Recognition', url: 'https://www.youtube.com/watch?v=example4' }
      ],
      comps: ['Bukayo Saka (playstyle)', 'Leroy Sané (movement)', 'Phil Foden (decision-making)'],
      videoUrl,
      createdAt: Date.now()
    };

    res.json({ ok: true, ...analysis });
  } catch (e) {
    console.error('[BK] Analyze error:', e);
    res.status(500).json({ ok: false, error: 'Analysis failed' });
  }
});

/* -------------------- Start -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on port ${PORT}`);
});
