// server.js
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  players: [],
  attrsByPlayer: {},
  clipsByPlayer: {}
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

/* -------------------- Start -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on port ${PORT}`);
});
