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

// CORS: allow your GH Pages + localhost to reach the API
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'https://smusoni.github.io'
  ],
  credentials: false
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.static('.')); // (optional) serve index.html etc

const PORT = process.env.PORT || 8080;

/* -------------------- Simple JSON "DB" -------------------- */
/**
 * db shape:
 * {
 *   users: [{ id, email, name, passHash, age, dob, createdAt }],
 *   profiles: { [userId]: { height, weight, foot, position, dob, age, updatedAt } },
 *   clipsByUser: { [userId]: [ { url, public_id, created_at, ... } ] },
 *   analysesByUser: { [userId]: [ { id, summary, focus[], drills[], comps[], video_url, public_id, created_at } ] }
 * }
 */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],
  profiles: {},
  clipsByUser: {},
  analysesByUser: {}
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
      db = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        profiles: parsed.profiles || {},
        clipsByUser: parsed.clipsByUser || {},
        analysesByUser: parsed.analysesByUser || {}
      };
      console.log('[BK] DB loaded:', {
        users: db.users.length,
        profiles: Object.keys(db.profiles).length,
        clips: Object.keys(db.clipsByUser).length,
        analyses: Object.keys(db.analysesByUser).length
      });
    } else {
      saveDB(true);
    }
  } catch (e) {
    console.error('[BK] Failed to load DB:', e);
    saveDB(true);
  }
}

let saveTimer = null;
function saveDB(immediate = false) {
  const write = () => fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
  try {
    ensureDataDir();
    if (immediate) return write();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { write(); } catch (e) { console.error('[BK] Save error:', e); }
      saveTimer = null;
    }, 300);
  } catch (e) {
    console.error('[BK] Save setup error:', e);
  }
}
loadDB();

/* -------------------- Helpers -------------------- */
const findUser = (email) =>
  db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());

const findUserById = (id) =>
  db.users.find(u => u.id === id);

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

/* -------------------- Routes -------------------- */
// Root + health
app.get('/', (_req, res) => res.send('ai-soccer-backend is running ✅'));
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

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
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
    const user = findUser(email);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const ok = await bcrypt.compare(String(password), user.passHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
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

// Profile GET/PUT/POST
app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
    clips: db.clipsByUser[req.userId] || [],
    analysis: (db.analysesByUser[req.userId] || [])[0] || null
  });
});

function upsertProfile(userId, body) {
  db.profiles[userId] = {
    ...(db.profiles[userId] || {}),
    // accept optional data; if omitted, keep previous
    height: body.height != null ? Number(body.height) : (db.profiles[userId]?.height ?? null),
    weight: body.weight != null ? Number(body.weight) : (db.profiles[userId]?.weight ?? null),
    foot: body.foot ?? (db.profiles[userId]?.foot ?? null),
    position: body.position ?? (db.profiles[userId]?.position ?? null),
    dob: body.dob ?? (db.profiles[userId]?.dob ?? null),
    age: body.age != null ? Number(body.age) : (db.profiles[userId]?.age ?? null),
    name: body.name ?? (db.profiles[userId]?.name ?? null),
    updatedAt: Date.now()
  };
}

app.put('/api/profile', auth, (req, res) => {
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});
app.post('/api/profile', auth, (req, res) => { // allow POST too
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

// Clip metadata
app.post('/api/clip', auth, (req, res) => {
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  if (!url && !public_id) {
    return res.status(400).json({ ok: false, error: 'url or public_id required' });
  }
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

/* -------------------- Library Endpoints -------------------- */
app.get('/api/analyses', auth, (req, res) => {
  const items = db.analysesByUser[req.userId] || [];
  res.json({ ok: true, items });
});

app.post('/api/analyses', auth, (req, res) => {
  const {
    summary, focus, drills, comps, videoUrl, publicId, raw
  } = req.body || {};
  const item = {
    id: uuidv4(),
    summary: summary || '',
    focus: Array.isArray(focus) ? focus : [],
    drills: Array.isArray(drills) ? drills : [],
    comps: Array.isArray(comps) ? comps : [],
    video_url: videoUrl || null,
    public_id: publicId || null,
    raw: raw || null,
    created_at: Date.now()
  };
  if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
  db.analysesByUser[req.userId].unshift(item);
  saveDB();
  res.json({ ok: true, item });
});

app.get('/api/analyses/:id', auth, (req, res) => {
  const list = db.analysesByUser[req.userId] || [];
  const item = list.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, item });
});

app.delete('/api/analyses/:id', auth, (req, res) => {
  const list = db.analysesByUser[req.userId] || [];
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  list.splice(idx, 1);
  db.analysesByUser[req.userId] = list;
  saveDB();
  res.json({ ok: true });
});

/* -------------------- Rules-based Analyze (seeded + youth/adult) -------------------- */
app.post('/api/analyze', auth, async (req, res) => {
  try {
    const { height = 0, weight = 0, foot = '', position = '', videoUrl = '', publicId = '' } = req.body || {};
    if (!videoUrl) return res.status(400).json({ ok: false, error: 'Video URL required' });

    // pull age from profile or user for youth/adult branching
    const profile = db.profiles[req.userId] || {};
    const user = findUserById(req.userId);
    const age = profile.age != null ? Number(profile.age) : (user?.age != null ? Number(user.age) : null);
    const isYouth = age != null ? age < 18 : false;

    // Seeded RNG so different clips vary but are stable per clip
    function xmur3(str) { let h = 1779033703 ^ str.length; for (let i=0;i<str.length;i++){ h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h<<13)|(h>>>19);} return function(){ h = Math.imul(h ^ (h>>>16), 2246822507); h = Math.imul(h ^ (h>>>13), 3266489909); return (h ^= h>>>16) >>> 0; }; }
    function mulberry32(a){ return function(){ let t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    const seedStr = (publicId || videoUrl || String(Date.now())).slice(-64);
    const rand = mulberry32(xmur3(seedStr)());
    const pick = (arr, n=1) => {
      const copy = [...arr];
      const out = [];
      while (copy.length && out.length < n) {
        const idx = Math.floor(rand()*copy.length);
        out.push(copy.splice(idx,1)[0]);
      }
      return out;
    };

    // quick features
    const hIn = Number(height)||0, wLb = Number(weight)||0;
    const bmi = hIn ? (wLb / (hIn*hIn)) * 703 : null;
    const isTall = hIn >= 72, isShort = hIn && hIn <= 66;
    const weakFootLabel = (foot||'').toLowerCase() !== 'both' ? `Weaker ${foot?.toLowerCase()==='right'?'left':'right'} foot` : null;

    // Focus pools per position
    const FOCUS = {
      'Goalkeeper': [
        'Set shape on low shots', 'High ball handling under pressure', '1v1 narrowing angles', 'Distribution choices after claim'
      ],
      'Right Back': [
        'Timing of overlaps', 'Body shape in 1v1 defending', 'Early cross selection', 'Weak-side compactness'
      ],
      'Left Back': [
        'Underlap recognition', 'First touch toward space', 'Back-post awareness', 'Recovery run angles'
      ],
      'Center Back': [
        'Hip orientation on turns', 'Line leadership & cues', 'Aerial duel timing', 'Breaking lines with passes'
      ],
      'Defensive Mid': [
        'Scanning before receiving', 'Press resistance in pocket', 'Cover shadows while pressing', 'Switch-of-play tempo'
      ],
      'Central Mid': [
        'Third-man runs', 'Weight of through balls', 'Counter-press triggers', 'Arrival into box'
      ],
      'Attacking Mid': [
        'Half-space positioning', 'Final-third decision speed', 'Feints to unbalance center backs', 'Cut-back creation'
      ],
      'Right Wing': [
        'First step separation', 'Weak-foot finishing patterns', 'Early vs delayed cross choices', 'Back-post defending'
      ],
      'Left Wing': [
        'Inside vs outside take-ons', 'Chop to shooting window', 'Far-post attacking runs', 'Counter-press effort'
      ],
      'Striker': [
        'Timing across the front post', 'Hold-up touch under pressure', 'Peeling off blind side', 'Finishing body shape'
      ]
    };

    // Drills
    const DRILLS_GENERIC_ADULT = [
      { title: 'Rondo 4v2 (high intensity)', url: 'https://youtu.be/3z1mP-rondo' },
      { title: 'First-touch gates (2-touch limit)', url: 'https://youtu.be/first-touch-gates' },
      { title: '1v1 transition box', url: 'https://youtu.be/1v1-transition' },
      { title: 'Scanning ladder (visual cues)', url: 'https://youtu.be/scanning-ladder' }
    ];
    const DRILLS_GENERIC_YOUTH = [
      { title: 'Rondo 4v1 (guided)', url: 'https://youtu.be/rondo-4v1' },
      { title: 'First-touch cones (inside/laces)', url: 'https://youtu.be/first-touch-youth' },
      { title: '1v1 gates (small area)', url: 'https://youtu.be/1v1-gates-youth' },
      { title: 'Scanning tag (head-up awareness)', url: 'https://youtu.be/scanning-tag' }
    ];
    const DRILLS_POS = {
      'Attacking Mid': [
        { title: 'Half-space pattern: bounce–turn–split', url: 'https://youtu.be/half-space-pattern' },
        { title: 'Cut-back finishing series', url: 'https://youtu.be/cut-back-series' }
      ],
      'Striker': [
        { title: 'Across-the-front finishing', url: 'https://youtu.be/front-post-finish' },
        { title: 'Hold-up & layoff circuit', url: 'https://youtu.be/holdup-layoff' }
      ],
      'Center Back': [
        { title: 'Open-body passing gates', url: 'https://youtu.be/cb-open-body' },
        { title: 'Aerial duel timing (coach call)', url: 'https://youtu.be/cb-aerial' }
      ]
    };

    const COMPS = {
      'Attacking Mid': ['Phil Foden','Martin Ødegaard','Jamal Musiala','Bruno Fernandes','Bernardo Silva'],
      'Striker': ['Erling Haaland','Lautaro Martínez','Ollie Watkins','Alexander Isak'],
      'Right Wing': ['Bukayo Saka','Mohamed Salah','Leroy Sané'],
      'Left Wing': ['Vinícius Júnior','Khvicha Kvaratskhelia','Heung-min Son'],
      'Center Back': ['William Saliba','Matthijs de Ligt','John Stones'],
      'Defensive Mid': ['Rodri','Declan Rice','Joshua Kimmich'],
      'Central Mid': ['Federico Valverde','Kevin De Bruyne','Pedri'],
      'Right Back': ['Achraf Hakimi','Trent Alexander-Arnold','Reece James'],
      'Left Back': ['Alphonso Davies','Theo Hernández','Andrew Robertson'],
      'Goalkeeper': ['Alisson Becker','Ederson','Mike Maignan']
    };

    const pos = position && FOCUS[position] ? position : 'Attacking Mid';

    // Build focus with personal add-ons
    const focusBase = [...FOCUS[pos]];
    if (weakFootLabel) focusBase.push(`${weakFootLabel} development`);
    if (isTall && /Wing|Attacking Mid/.test(pos)) focusBase.push('Lower center of gravity on turns');
    if (isShort && /Center Back|Striker/.test(pos)) focusBase.push('Early body contact to create space');
    if (isYouth) focusBase.push('Fundamental technique under low pressure');
    const chosenFocus = pick(focusBase, 3 + Math.floor(rand()*1)); // 3–4

    // Drills: mix position + generic for youth/adult
    const baseGeneric = isYouth ? DRILLS_GENERIC_YOUTH : DRILLS_GENERIC_ADULT;
    const drillPool = [...(DRILLS_POS[pos] || []), ...baseGeneric];
    if (weakFootLabel) drillPool.unshift({ title: '100 weak-foot reps (inside/lace/instep)', url: 'https://youtu.be/weak-foot-100' });
    const chosenDrills = pick(drillPool, 3 + Math.floor(rand()*1)); // 3–4

    // Comps
    const compPool = COMPS[pos] || COMPS['Attacking Mid'];
    const chosenComps = pick(compPool, 2);

    // Summary
    const footTxt = foot ? `${foot.toLowerCase()}-footed` : '';
    const phys = (hIn && wLb) ? `(${hIn} in / ${wLb} lbs)` : '';
    const bmiNote = bmi
      ? (bmi > 27 ? 'Powerful build—keep agility sharp.' :
         bmi < 20 ? 'Light frame—add strength for duels.' :
         'Balanced build supporting repeat efforts.')
      : '';
    const youthTag = isYouth ? ' (youth focus)' : '';
    const posPhrase = pos === 'Attacking Mid' ? 'final-third combinations and receiving between lines'
                    : pos === 'Striker' ? 'penalty-area movement and finishing windows'
                    : pos === 'Center Back' ? 'defensive line management and first pass quality'
                    : 'role responsibilities';

    const summary =
      `As a ${footTxt ? footTxt + ' ' : ''}${pos}${youthTag}, you show promising tendencies in ${posPhrase}. ` +
      `${phys ? `Your physical profile ${phys} informs your playstyle. ` : ''}` +
      `${bmiNote ? bmiNote + ' ' : ''}` +
      (isYouth
        ? 'We emphasize technique, decision-making, and safe progressions before adding load.'
        : 'We emphasize repeatable actions at game tempo with progressive intensity.');

    // Return (client already saves to library; you can also save here if you prefer)
    return res.json({
      ok: true,
      summary,
      focus: chosenFocus,
      drills: chosenDrills,
      comps: chosenComps,
      videoUrl,
      createdAt: Date.now()
    });
  } catch (e) {
    console.error('[BK] Analyze error:', e);
    res.status(500).json({ ok: false, error: 'Analysis failed' });
  }
});

/* -------------------- Start -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on port ${PORT}`);
});
