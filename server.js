// server.js
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

/* ========= ENV & BASIC CONFIG ========= */
const JWT_SECRET  = process.env.JWT_SECRET       || 'dev_secret_change_me';
const OPENAI_KEY  = process.env.OPENAI_API_KEY   || '';
const APP_ORIGINS = (process.env.APP_ORIGINS     || 'https://smusoni.github.io,http://localhost:8080')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors({ origin: APP_ORIGINS, credentials: false }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static('.'));

const PORT = process.env.PORT || 8080;

/* ========= JSON "DB" ========= */
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],
  profiles: {},        // userId -> profile
  clipsByUser: {},     // userId -> [clips]
  analysesByUser: {},  // userId -> [analyses]
  ownerByPublicId: {}  // public_id -> userId
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_PATH)) {
      const onDisk = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      db = { ...db, ...onDisk };
    }
  } catch (e) {
    console.error('[BK] loadDB error', e);
  }
}
loadDB();

let saveTimer = null;
function saveDB(immediate = false) {
  const write = () => {
    ensureDataDir();
    fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
  };
  if (immediate) return write();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { write(); } catch (e) { console.error('[BK] saveDB error', e); }
    saveTimer = null;
  }, 250);
}

/* ========= HELPERS ========= */
const findUser     = email => db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
const findUserById = id    => db.users.find(u => u.id === id);

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

/* ========= OpenAI client ========= */
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* ========= Misc endpoints ========= */
app.get('/', (_req, res) =>
  res.send('ai-soccer-backend (BallKnowledge Part 1 – training clip analysis) ✅')
);

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, uptime: process.uptime() })
);

/* ========= Auth ========= */
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

    const token = jwt.sign(
      { sub: id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      ok: true,
      token,
      user: { id, name: user.name, email: user.email }
    });
  } catch (e) {
    console.error('[BK] signup error', e);
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

    const ok = await bcrypt.compare(String(password), user.passHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (e) {
    console.error('[BK] login error', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/me', auth, (req, res) => {
  const u = findUserById(req.userId);
  if (!u) return res.status(404).json({ ok: false, error: 'User not found' });
  res.json({
    ok: true,
    user: { id: u.id, name: u.name, email: u.email }
  });
});

/* ========= Profile ========= */
/**
 * We store:
 * - height in TOTAL inches (but UI uses feet + inches)
 * - weight, foot, position
 * - dob, age, name
 * - current skill / focus area
 */
function upsertProfile(userId, body) {
  const existing = db.profiles[userId] || {};
  let heightInches = existing.height ?? null;

  // Prefer feet + inches if provided
  if (body.heightFeet != null || body.heightInches != null) {
    const ft   = Number(body.heightFeet || 0);
    const inch = Number(body.heightInches || 0);
    const total = ft * 12 + inch;
    if (total > 0) heightInches = total;
  } else if (body.height != null) {
    const h = Number(body.height);
    if (!Number.isNaN(h) && h > 0) heightInches = h;
  }

  db.profiles[userId] = {
    ...existing,
    height:   heightInches,
    weight:   body.weight   ?? existing.weight   ?? null,
    foot:     body.foot     ?? existing.foot     ?? null,
    position: body.position ?? existing.position ?? null,
    dob:      body.dob      ?? existing.dob      ?? null,
    age:      body.age      ?? existing.age      ?? findUserById(userId)?.age ?? null,
    name:     body.name     ?? existing.name     ?? null,
    skill:    body.skill    ?? existing.skill    ?? null,
    updatedAt: Date.now()
  };
}

app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
    clips: db.clipsByUser[req.userId] || [],
    analysis: (db.analysesByUser[req.userId] || [])[0] || null
  });
});

app.put('/api/profile', auth, (req, res) => {
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

app.post('/api/profile', auth, (req, res) => {
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

/* ========= Clips (Cloudinary metadata from frontend) ========= */
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
  if (public_id) db.ownerByPublicId[public_id] = req.userId;
  saveDB();

  res.json({ ok: true, clip, total: db.clipsByUser[req.userId].length });
});

/* ========= Library ========= */
app.get('/api/analyses', auth, (req, res) => {
  res.json({ ok: true, items: db.analysesByUser[req.userId] || [] });
});

app.post('/api/analyses', auth, (req, res) => {
  const { summary, focus, drills, videoUrl, publicId, raw, skill } = req.body || {};
  if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];

  const item = {
    id: uuidv4(),
    summary: summary || '',
    focus: Array.isArray(focus) ? focus : [],
    drills: Array.isArray(drills) ? drills : [],
    video_url: videoUrl || null,
    public_id: publicId || null,
    skill: skill || null,
    raw: raw || null,
    created_at: Date.now()
  };

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

/* ========= Core Part 1: Training clip analysis ========= */

async function runTextAnalysisForTraining({ profile, user, videoUrl, skill }) {
  // If OpenAI key missing, fallback generic
  if (!openai) {
    const genericSummary = `Quick training analysis for ${profile.position || 'your role'}. Keep focusing on clean technique, good body shape, and scanning before the ball arrives.`;
    return {
      summary: genericSummary,
      focus: [
        'Maintain balanced body shape when receiving and striking the ball.',
        'Scan the field before the ball arrives to improve decisions.',
        'Control first touch away from pressure and into space.'
      ],
      drills: [
        { title: 'Wall passing with directional first touch', url: 'https://youtu.be/ZNk6NIxPkb0' },
        { title: '1v1 change-of-direction cone drill',        url: 'https://youtu.be/0W2bXg2NaqE' },
        { title: 'First-touch receiving patterns',            url: 'https://youtu.be/x7Jr8OZnS7U' }
      ],
      raw: null
    };
  }

  const age     = profile.age ?? user?.age ?? null;
  const isYouth = age != null ? Number(age) < 18 : false;

  const context = {
    name: user?.name || null,
    age,
    isYouth,
    position: profile.position || 'Unknown',
    dominantFoot: profile.foot || 'Unknown',
    heightInches: profile.height || null,
    weightLbs: profile.weight || null,
    skillWorkingOn: skill || profile.skill || null,
    videoUrl
  };

  const systemPrompt = `
You are a soccer performance trainer working 1:1 with players.

Return STRICT JSON ONLY with this shape:

{
  "summary": string,        // 3–6 sentences, specific & encouraging
  "focus":   string[3..6],  // bullet-style phrases describing key focus areas
  "drills":  [              // 3–6 drills with title + link to a resource
    { "title": string, "url": string }
  ]
}

Guidelines:
- Tailor everything to THIS player: age, position, dominant foot, and the skill they're working on.
- Assume the attached clip shows them training that skill (not a full match).
- If they are youth, keep language simple and supportive.
- Be very specific about HOW to fix technique (body shape, timing, contact point, etc).
- Do NOT mention JSON, keys, or that you are an AI. Just output valid JSON.
`.trim();

  const userPrompt = `
Player context:

${JSON.stringify(context, null, 2)}

Assume the clip is them working on that specific skill in a realistic training setup.
Give clear coaching feedback that will help them improve in their next session.
`.trim();

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt }
    ]
  });

  const rawContent = resp.choices?.[0]?.message?.content || '{}';
  const jsonText   = typeof rawContent === 'string'
    ? rawContent
    : JSON.stringify(rawContent);

  let data = {};
  try {
    data = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }

  return {
    summary: data.summary || 'Training analysis complete.',
    focus: Array.isArray(data.focus) ? data.focus.slice(0, 6) : [],
    drills: Array.isArray(data.drills) ? data.drills.slice(0, 6) : [],
    raw: data
  };
}

app.post('/api/analyze', auth, async (req, res) => {
  try {
    const {
      height,
      heightFeet,
      heightInches,
      weight,
      foot,
      position,
      videoUrl,
      publicId,
      skill
    } = req.body || {};

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Video URL required' });
    }

    // Update / enrich profile with latest form values
    const profilePatch = {
      height,
      heightFeet,
      heightInches,
      weight,
      foot,
      position,
      skill
    };
    upsertProfile(req.userId, profilePatch);
    saveDB();

    const profile = db.profiles[req.userId] || {};
    const user    = findUserById(req.userId) || {};

    // Run OpenAI analysis (synchronous – real-time)
    const result = await runTextAnalysisForTraining({
      profile,
      user,
      videoUrl,
      skill: skill || profile.skill || null
    });

    // Save into Library immediately
    if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
    const item = {
      id: uuidv4(),
      summary: result.summary,
      focus: result.focus,
      drills: result.drills,
      video_url: videoUrl,
      public_id: publicId || null,
      skill: skill || profile.skill || null,
      raw: result.raw,
      created_at: Date.now()
    };
    db.analysesByUser[req.userId].unshift(item);
    saveDB();

    // Return full report to the frontend in real time
    res.json({
      ok: true,
      summary: result.summary,
      focus: result.focus,
      drills: result.drills,
      videoUrl,
      publicId,
      skill: item.skill
    });
  } catch (e) {
    console.error('[BK] /api/analyze error', e);
    res.status(500).json({ ok: false, error: 'Analysis failed' });
  }
});

/* ========= Webhook stub (Vision disabled for Part 1) ========= */
app.post('/webhooks/cloudinary', express.json({ limit: '1mb' }), (req, res) => {
  console.log(
    '[WH] Cloudinary webhook received (vision worker disabled for Part 1).',
    'public_id =',
    req.body?.public_id || req.body?.asset_id || 'n/a'
  );
  // For Part 1 we just acknowledge so Cloudinary stops retrying.
  res.status(200).json({ ok: true });
});

/* ========= Start server ========= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on ${PORT}`);
});
