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
  users: [],                // [{ id, email, name, passHash, age, dob, createdAt }]
  profiles: {},             // { userId: { height (inches), weight (lbs), foot, position, updatedAt } }
  clipsByUser: {},          // { userId: [ { url, public_id, created_at, ... } ] }
  analysesByUser: {}        // { userId: { summary, focus[], drills[], comps[], createdAt } }
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

// Get profile
app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
    clips: db.clipsByUser[req.userId] || [],
    analysis: db.analysesByUser[req.userId] || null
  });
});

// Save/Update profile
app.post('/api/profile', auth, (req, res) => {
  const { height, weight, foot, position, dob } = req.body || {};
  
  db.profiles[req.userId] = {
    ...(db.profiles[req.userId] || {}),
    height: height ? Number(height) : null,
    weight: weight ? Number(weight) : null,
    foot: foot || null,
    position: position || null,
    dob: dob || null,
    updatedAt: Date.now()
  };
  
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

// Add clip metadata
app.post('/api/clip', auth, (req, res) => {
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  
  if (!url && !public_id) {
    return res.status(400).json({ ok: false, error: 'url or public_id required' });
  }

  if (!Array.isArray(db.clipsByUser[req.userId])) {
    db.clipsByUser[req.userId] = [];
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
  
  db.clipsByUser[req.userId].unshift(clip);
  saveDB();
  
  res.json({ ok: true, clip, total: db.clipsByUser[req.userId].length });
});

// Analyze
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

    // Mock analysis result matching frontend expectations
    const analysis = {
      summary: `Strong technical foundation observed. Your ${position || 'play'} shows good spatial awareness and decision-making speed. Focus areas identified for optimal development.`,
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

    db.analysesByUser[req.userId] = analysis;
    saveDB();

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
