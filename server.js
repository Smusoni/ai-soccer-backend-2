// server.js  — BallKnowledge Part 1 (training-clip, real-time analysis with video frames)
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

/* ---------- ENV + constants ---------- */
const JWT_SECRET   = process.env.JWT_SECRET || 'dev_secret_change_me';
const OPENAI_KEY   = process.env.OPENAI_API_KEY || '';
const APP_ORIGINS  = (process.env.APP_ORIGINS ||
  'https://smusoni.github.io,http://localhost:8080')
  .split(',').map(s => s.trim()).filter(Boolean);

// NEW: needed to build Cloudinary frame URLs
const CLOUD_NAME   = process.env.CLOUD_NAME || '';

const PORT = process.env.PORT || 8080;

/* ---------- Express setup ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: APP_ORIGINS,
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.static('.'));

/* ---------- Tiny JSON "DB" ---------- */
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],              // [{id,name,email,passHash,age,dob,createdAt}]
  profiles: {},           // userId -> profile
  clipsByUser: {},        // userId -> [{...clip}]
  analysesByUser: {},     // userId -> [{...analysis}]
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  ensureDataDir();
  if (fs.existsSync(DATA_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      db = { ...db, ...raw };
    } catch (e) {
      console.error('[BK] loadDB error', e);
    }
  }
}

let saveTimer = null;
function saveDB(immediate = false) {
  const write = () => {
    ensureDataDir();
    fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
  };

  if (immediate) return write();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { write(); } catch (e) { console.error('[BK] saveDB', e); }
    saveTimer = null;
  }, 250);
}

loadDB();

/* ---------- Helpers ---------- */
const findUser     = email =>
  db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
const findUserById = id => db.users.find(u => u.id === id);

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

/* ---------- OpenAI client ---------- */
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* ---------- Misc ---------- */
app.get('/', (_req, res) =>
  res.send('BallKnowledge backend (Part 1 – training clip analysis) ✅'));
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, uptime: process.uptime() }));

/* ==================================================================== */
/*                               AUTH                                   */
/* ==================================================================== */

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
      createdAt: Date.now(),
    };

    db.users.push(user);
    saveDB();

    const token = jwt.sign(
      { sub: id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' },
    );

    res.json({
      ok: true,
      token,
      user: { id, name: user.name, email: user.email },
    });
  } catch (e) {
    console.error('[BK] signup', e);
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
      { expiresIn: '30d' },
    );

    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (e) {
    console.error('[BK] login', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/me', auth, (req, res) => {
  const u = findUserById(req.userId);
  if (!u) return res.status(404).json({ ok: false, error: 'User not found' });
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email } });
});

/* ==================================================================== */
/*                              PROFILE                                 */
/* ==================================================================== */

// We store height as TOTAL INCHES, but accept feet + inches from the client.
function upsertProfile(userId, body) {
  const existing = db.profiles[userId] || {};
  let heightInches = existing.height ?? null;

  if (body.heightFeet != null || body.heightInches != null) {
    const ft = Number(body.heightFeet || 0);
    const inch = Number(body.heightInches || 0);
    const total = ft * 12 + inch;
    if (total > 0) heightInches = total;
  } else if (body.height != null) {
    const h = Number(body.height);
    if (!Number.isNaN(h) && h > 0) heightInches = h;
  }

  db.profiles[userId] = {
    ...existing,
    name: body.name ?? existing.name ?? null,
    age: body.age ?? existing.age ?? findUserById(userId)?.age ?? null,
    dob: body.dob ?? existing.dob ?? null,
    height: heightInches,
    weight: body.weight ?? existing.weight ?? null,
    foot: body.foot ?? existing.foot ?? null,
    position: body.position ?? existing.position ?? null,
    skill: body.skill ?? existing.skill ?? null, // what they’re working on in this clip
    updatedAt: Date.now(),
  };
}

app.get('/api/profile', auth, (req, res) => {
  res.json({
    ok: true,
    profile: db.profiles[req.userId] || {},
  });
});

app.put('/api/profile', auth, (req, res) => {
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok: true, profile: db.profiles[req.userId] });
});

/* ==================================================================== */
/*                                CLIPS                                  */
/* ==================================================================== */

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
    format: format || null,
  };

  db.clipsByUser[req.userId].unshift(clip);
  saveDB();

  res.json({ ok: true, clip, total: db.clipsByUser[req.userId].length });
});

/* ==================================================================== */
/*                               LIBRARY                                 */
/* ==================================================================== */

app.get('/api/analyses', auth, (req, res) => {
  res.json({ ok: true, items: db.analysesByUser[req.userId] || [] });
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

/* ==================================================================== */
/*                    VIDEO FRAME SAMPLING (Cloudinary)                  */
/* ==================================================================== */

function sampleFrameUrls({ publicId, duration, n = 8 }) {
  if (!CLOUD_NAME || !publicId) return [];

  const totalFrames = Math.max(4, Math.min(n, 16));
  const clipDuration = Number(duration) > 0 ? Number(duration) : 40; // default 40s
  const span = Math.max(1, Math.floor(clipDuration / (totalFrames + 1)));

  const seconds = [];
  for (let i = 1; i <= totalFrames; i++) {
    seconds.push(i * span);
  }

  return seconds.map(s =>
    `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/so_${s}/${publicId}.jpg`
  );
}

/* ==================================================================== */
/*                     PART 1: TRAINING CLIP ANALYSIS                    */
/* ==================================================================== */

async function runTrainingAnalysis({ profile, user, videoUrl, skill, frames }) {
  if (!openai) {
    // Fallback if API key missing
    const genericSummary = `Quick training analysis for ${profile.position || 'your role'}. Continue focusing on your technique and decision making.`;
    const fallbackDrills = [
      {
        title: 'Wall passes with tight touch',
        url: 'https://www.youtube.com/results?search_query=' +
          encodeURIComponent('Wall passes with tight touch soccer drill'),
      },
      {
        title: '1v1 change-of-direction drill',
        url: 'https://www.youtube.com/results?search_query=' +
          encodeURIComponent('1v1 change of direction soccer drill'),
      },
      {
        title: 'First-touch receiving patterns',
        url: 'https://www.youtube.com/results?search_query=' +
          encodeURIComponent('first touch receiving patterns soccer drill'),
      },
    ];
    return {
      summary: genericSummary,
      focus: [
        'Technical repetition',
        'Decision making under light pressure',
        'Consistent body shape on the ball',
      ],
      drills: fallbackDrills,
      comps: [], // not used on frontend
    };
  }

  const age = profile.age ?? user?.age ?? null;
  const isYouth = age != null ? Number(age) < 18 : false;
  const heightIn = profile.height || null;
  const weightLb = profile.weight || null;

  const sys = `You are a soccer performance trainer working 1:1 with players.
You receive:
- Player context (age, position, dominant foot, height, weight, and a text hint of the skill they're working on)
- A SMALL SET OF FRAMES taken from the actual training clip.

You must analyze WHAT YOU SEE IN THE FRAMES FIRST.
The "skillWorkingOn" hint is just a hint; if it does NOT match the clip, TRUST THE CLIP.

Return STRICT JSON ONLY with fields:

{
  "summary": string,           // 3–6 sentences, direct and encouraging
  "focus": string[3..6],       // bullet-level phrases describing what to focus on
  "drills": [                  // 3–6 drills, each with title + url
    { "title": string, "url": string }
  ],
  "comps": string[0..4]        // similar pro players or examples (may be empty)
}

Guidelines:
- Base your coaching on the MOVEMENTS in the frames: touches, turns, ball striking, scanning, body shape, timing, etc.
- If the typed "skill" says something different (e.g. "free kicks") but frames show turns or dribbling, WRITE ABOUT TURNS/DRIBBLING.
- If they’re youth, keep language simple and supportive.
- Be specific about HOW to execute and fix technique, not generic effort advice.
- For drills, choose short descriptive titles. You MAY leave "url" empty or generic; the backend will convert titles into YouTube searches.
- Do NOT mention JSON, keys, or that you are an AI. Just output valid JSON.`;

  const context = {
    name: user?.name || null,
    age,
    isYouth,
    position: profile.position || 'Unknown',
    dominantFoot: profile.foot || 'Unknown',
    heightIn,
    weightLb,
    skillWorkingOn: skill || profile.skill || null,
    videoUrl,
  };

  const userParts = [
    {
      type: 'text',
      text:
        `Player context:\n` +
        `${JSON.stringify(context, null, 2)}\n\n` +
        `Use the FRAMES below to understand what the player is actually doing. ` +
        `If the frames do not match the skill hint, prioritize what you SEE.`,
    },
  ];

  if (Array.isArray(frames) && frames.length) {
    for (const url of frames) {
      userParts.push({
        type: 'input_image',
        image_url: { url },
      });
    }
  }

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userParts },
    ],
  });

  let rawContent = resp.choices?.[0]?.message?.content ?? '{}';

  // content can be a string or an array of parts; normalize to string
  if (Array.isArray(rawContent)) {
    rawContent = rawContent.map(part => (
      typeof part === 'string' ? part : (part.text || '')
    )).join('\n');
  }

  const jsonText = typeof rawContent === 'string'
    ? rawContent
    : JSON.stringify(rawContent);

  let data = {};
  try {
    data = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) {
      data = JSON.parse(m[0]);
    }
  }

  // Normalize drills → always valid YouTube search URLs
  const normalizedDrills = Array.isArray(data.drills)
    ? data.drills.slice(0, 6).map(d => {
        const title = typeof d === 'string' ? d : (d.title || 'Soccer drill');
        let url = d.url;

        if (!url || !/^https?:\/\//.test(url)) {
          url = 'https://www.youtube.com/results?search_query=' +
            encodeURIComponent(`${title} soccer drill`);
        }

        return { title, url };
      })
    : [];

  return {
    summary: data.summary || 'Training analysis complete.',
    focus: Array.isArray(data.focus) ? data.focus.slice(0, 6) : [],
    drills: normalizedDrills,
    comps: Array.isArray(data.comps) ? data.comps.slice(0, 4) : [],
    raw: data,
  };
}

app.post('/api/analyze', auth, async (req, res) => {
  try {
    const {
      height, heightFeet, heightInches,
      weight, foot, position,
      videoUrl, publicId,
      skill,
    } = req.body || {};

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Video URL required' });
    }

    // Update + enrich profile before analysis
    const profilePatch = {
      height,
      heightFeet,
      heightInches,
      weight,
      foot,
      position,
      skill,
    };
    upsertProfile(req.userId, profilePatch);
    saveDB();

    const profile = db.profiles[req.userId] || {};
    const user    = findUserById(req.userId) || {};

    // Look up clip to get duration (for better frame spacing)
    const clips = db.clipsByUser[req.userId] || [];
    const clip  = clips.find(c =>
      (publicId && c.public_id === publicId) ||
      (!publicId && c.url === videoUrl)
    );
    const duration = clip?.duration || null;

    // Build video frames from Cloudinary if possible
    let frames = [];
    if (CLOUD_NAME && (publicId || clip?.public_id)) {
      const pid = publicId || clip.public_id;
      frames = sampleFrameUrls({ publicId: pid, duration });
    }

    // Run OpenAI (with frames if we have them)
    const result = await runTrainingAnalysis({
      profile,
      user,
      videoUrl,
      skill: skill || profile.skill || null,
      frames,
    });

    // Save into Library
    if (!Array.isArray(db.analysesByUser[req.userId])) {
      db.analysesByUser[req.userId] = [];
    }

    const item = {
      id: uuidv4(),
      summary: result.summary,
      focus: result.focus,
      drills: result.drills,
      comps: result.comps,
      video_url: videoUrl,
      public_id: publicId || null,
      skill: skill || profile.skill || null,
      raw: result.raw,
      created_at: Date.now(),
    };

    db.analysesByUser[req.userId].unshift(item);
    saveDB();

    // Send full report + id back to frontend
    res.json({
      ok: true,
      id: item.id,
      summary: item.summary,
      focus: item.focus,
      drills: item.drills,
      comps: item.comps,
      videoUrl: item.video_url,
      publicId: item.public_id,
      skill: item.skill,
    });
  } catch (e) {
    console.error('[BK] analyze', e);
    res.status(500).json({ ok: false, error: 'Analysis failed' });
  }
});

/* ---------- Start server ---------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BallKnowledge backend running on ${PORT}`);
});
