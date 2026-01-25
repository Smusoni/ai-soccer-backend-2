// server.js — BallKnowledge Part 1 (training-clip, real-time analysis only)
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

/* ---------- ENV + constants ---------- */
const JWT_SECRET  = process.env.JWT_SECRET || 'dev_secret_change_me';
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';
const APP_ORIGINS = (process.env.APP_ORIGINS ||
  'https://smusoni.github.io,http://localhost:8080')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PORT = process.env.PORT || 3001;

/* ---------- Express setup ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

app.use(cors({ origin: APP_ORIGINS }));
app.use(express.json({ limit: "2mb" }));
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
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Video Frame Extraction ---------- */
async function downloadVideoFrames(videoUrl) {
  try {
    // For Cloudinary, we can directly get preview frames using transformations
    // Extract multiple frames at different timestamps to get comprehensive view
    const frames = [];
    
    if (videoUrl && videoUrl.includes('cloudinary')) {
      // Get frames at 25%, 50%, and 75% of video using Cloudinary transformations
      const timestamps = ['0.25', '0.50', '0.75'];
      
      for (const time of timestamps) {
        try {
          // Cloudinary format: add so_(start_time) to get frame at specific time
          const frameUrl = videoUrl.replace(/\/upload\//, `/upload/so_${time},w_800,c_scale,q_80,f_jpg/`);
          frames.push(frameUrl);
        } catch (e) {
          console.log(`[BK] Could not create frame URL for time ${time}`);
        }
      }
    }
    
    return frames.length > 0 ? frames : null;
  } catch (err) {
    console.error('[BK] Error extracting video frames:', err.message);
    return null;
  }
}

/* ---------- Misc ---------- */
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, uptime: process.uptime() }),
);
app.get('/api/test', (_req, res) =>
  res.json({ ok: true, message: 'Test route working!', timestamp: new Date().toISOString() }),
);

app.post('/api/test-openai', async (req, res) => {
  try {
    if (!openai) {
      return res.status(400).json({ 
        ok: false, 
        error: 'OpenAI API key not configured' 
      });
    }

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { 
          role: 'system', 
          content: 'You are a helpful soccer coach.' 
        },
        { 
          role: 'user', 
          content: 'Give me one quick soccer training tip in 2 sentences.' 
        },
      ],
    });

    const message = resp.choices?.[0]?.message?.content || 'No response';
    res.json({ 
      ok: true, 
      message: message,
      model: resp.model,
      usage: resp.usage 
    });
  } catch (error) {
    console.error('[BK] test-openai error:', error.message);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

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
      dob: String(dob).trim(), // Store as plain string, no timezone conversion
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
    res.status(500).json({ ok: false, error: 'Server error (signup)' });
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
    res.status(500).json({ ok: false, error: 'Server error (login)' });
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
    name: body.name ?? existing.name ?? null,
    age: body.age ?? existing.age ?? findUserById(userId)?.age ?? null,
    dob: body.dob ?? existing.dob ?? null,
    height: heightInches,
    weight: body.weight ?? existing.weight ?? null,
    foot: body.foot ?? existing.foot ?? null,
    position: body.position ?? existing.position ?? null,
    skill: body.skill ?? existing.skill ?? null, // “what they’re working on”
    updatedAt: Date.now(),
  };
}

app.get('/api/profile', auth, (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  
  const profile = db.profiles[req.userId] || {};
  // Use dob from signup (user object) as the source of truth, unless explicitly updated in profile
  const dob = profile.dob || user.dob;
  
  res.json({ 
    ok: true, 
    user: { 
      id: user.id,
      name: user.name, 
      email: user.email, 
      age: user.age,
      dob: dob
    },
    profile: profile
  });
});

app.post('/api/profile', auth, (req, res) => {
  const { name, age, dob, position, foot, height, weight } = req.body || {};
  const user = findUserById(req.userId);
  
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  
  // Update user data
  if (name) user.name = name;
  if (age) user.age = Number(age);
  if (dob) user.dob = String(dob).trim(); // Store dob as plain string, no conversion
  
  // Update profile data
  upsertProfile(req.userId, {
    position: position || null,
    foot: foot || null,
    height: Number(height) || null,
    weight: Number(weight) || null,
  });
  
  saveDB();
  
  const finalDob = dob || user.dob;
  res.json({ 
    ok: true,
    user: { 
      id: user.id,
      name: user.name, 
      email: user.email, 
      age: user.age,
      dob: finalDob
    },
    profile: db.profiles[req.userId] 
  });
});

app.put('/api/profile', auth, (req, res) => {
  upsertProfile(req.userId, req.body || {});
  saveDB();
  const user = findUserById(req.userId);
  res.json({ 
    ok: true,
    user: { 
      id: user.id,
      name: user.name, 
      email: user.email, 
      age: user.age,
      dob: user.dob 
    },
    profile: db.profiles[req.userId] 
  });
});

/* ==================================================================== */
/*                                CLIPS                                  */
/* ==================================================================== */

app.post('/api/clip', auth, (req, res) => {
  const {
    url, public_id, created_at,
    bytes, duration, width, height, format,
  } = req.body || {};

  if (!url && !public_id) {
    return res.status(400).json({ ok: false, error: 'url or public_id required' });
  }

  if (!Array.isArray(db.clipsByUser[req.userId])) db.clipsByUser[req.userId] = [];

  const clip = {
    url:        url || null,
    public_id:  public_id || null,
    created_at: created_at || new Date().toISOString(),
    bytes:      Number(bytes) || null,
    duration:   Number(duration) || null,
    width:      Number(width) || null,
    height:     Number(height) || null,
    format:     format || null,
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
/*                     PART 1: TRAINING CLIP ANALYSIS                    */
/* ==================================================================== */

async function runTextAnalysisForTraining({ profile, user, videoUrl, skill }) {
  if (!openai) {
    // Fallback if API key missing
    const genericSummary =
      `Quick training analysis for ${profile.position || 'your role'}. ` +
      'Continue focusing on your technique and decision making.';

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
      comps: [],
    };
  }

  const age      = profile.age ?? user?.age ?? null;
  const isYouth  = age != null ? Number(age) < 18 : false;
  const heightIn = profile.height || null;
  const weightLb = profile.weight || null;

  const sys = `You are an expert soccer coach analyzing a player's training video.

CRITICAL INSTRUCTIONS:
1. Your ONLY job is to analyze what you see in the video frames provided
2. COMPLETELY IGNORE any text suggestions about what skill they're working on
3. Identify the ACTUAL activity visible in the frames (juggling, passing, dribbling, shooting, etc.)
4. Do NOT guess or assume - describe ONLY what you see

IMPORTANT: If you see juggling, say "juggling". If you see passing drills, say "passing". Be specific and accurate about the activity.

Provide DETAILED, ACTIONABLE coaching feedback that helps the player improve.

Return analysis in STRICT JSON format:
{
  "activity": "The specific activity you observe (e.g., 'juggling', 'passing drills', 'dribbling practice')",
  "summary": "Detailed assessment of what the player is doing, their form/technique, strengths observed, and immediate improvements needed. Reference the activity by name. 2-3 sentences minimum.",
  "focus": [
    "Specific technical point to improve based on what you see",
    "Physical/fitness focus area",
    "Decision-making or game sense point",
    "Complementary skill to develop"
  ],
  "drills": [
    {"title": "Specific drill name for this activity", "description": "How to perform this drill and why it helps"},
    {"title": "Another related drill", "description": "What this develops"}
  ],
  "improvements": [
    "Actionable improvement 1: What to focus on and how to fix it",
    "Actionable improvement 2: Specific technique adjustment"
  ]
}

Make the summary vivid and specific. Reference actual movements and the activity you see in the video.
NEVER make assumptions - analyze ONLY what is visible in the frames.
Base feedback ONLY on what you see in the video frames.`;

  const context = {
    name:          user?.name || null,
    age,
    isYouth,
    position:      profile.position || 'Unknown',
    dominantFoot:  profile.foot || 'Unknown',
    heightIn,
    weightLb,
    skillWorkingOn: skill || profile.skill || null,
    videoUrl,
  };

  const userText = `Player Profile:
- Name: ${user?.name || 'Unknown'}
- Age: ${age || 'Unknown'}  
- Position: ${profile.position || 'Unknown'}
- Dominant Foot: ${profile.foot || 'Unknown'}

You are seeing video frames from a soccer training session. Analyze what the player is actually doing.
Provide coaching feedback based ONLY on what you observe in the frames, not on any text suggestions.`;

  const messageContent = [
    {
      type: 'text',
      text: userText,
    },
  ];

  // Extract video frames from Cloudinary
  const frameUrls = await downloadVideoFrames(videoUrl);
  console.log(`[BK] Video URL: ${videoUrl}`);
  console.log(`[BK] Frame extraction result:`, frameUrls);
  
  if (frameUrls && frameUrls.length > 0) {
    console.log(`[BK] Adding ${frameUrls.length} video frames for analysis`);
    for (const frameUrl of frameUrls) {
      console.log(`[BK] Frame URL: ${frameUrl}`);
      messageContent.push({
        type: 'image_url',
        image_url: {
          url: frameUrl,
        },
      });
    }
  } else {
    console.log('[BK] No video frames extracted - falling back to text only');
    if (skill && skill.trim()) {
      messageContent[0].text += `\n\nAdditional context: ${skill}`;
    }
  }

  console.log(`[BK] Message content count: ${messageContent.length} items`);
  const resp = await openai.chat.completions.create({
    model: 'gpt-5.1',
    temperature: 0.4,
    max_tokens: 1500,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: messageContent },
    ],
  }).catch(error => {
    console.error('[BK] OpenAI error:', error.message);
    throw error;
  });

  const rawContent = resp.choices?.[0]?.message?.content || '{}';
  const jsonText   =
    typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);

  console.log(`[BK] Raw OpenAI response:`, rawContent);

  let data = {};
  try {
    data = JSON.parse(jsonText);
  } catch {
    // Handle ```json blocks
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }

  console.log(`[BK] Parsed analysis data:`, data);

  // Normalize drills - create YouTube search URLs from descriptions
  const normalizedDrills = Array.isArray(data.drills)
    ? data.drills.slice(0, 5).map(d => {
        const title = typeof d === 'string' ? d : (d.title || 'Soccer drill');
        const description = d.description || '';
        const url = 'https://www.youtube.com/results?search_query=' +
          encodeURIComponent(`${title} soccer drill training`);
        return { title, description, url };
      })
    : [];

  return {
    summary: data.summary || 'Training analysis complete.',
    focus: Array.isArray(data.focus) ? data.focus.slice(0, 5) : [],
    drills: normalizedDrills,
    improvements: Array.isArray(data.improvements) ? data.improvements.slice(0, 4) : [],
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

    console.log(`[BK] Analyze request - videoUrl: ${videoUrl}, skill: ${skill}`);

    if (!videoUrl) {
      return res
        .status(400)
        .json({ ok: false, error: 'Upload a training clip before analyzing.' });
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

    const result = await runTextAnalysisForTraining({
      profile,
      user,
      videoUrl,
      skill: skill || profile.skill || null,
    });

    if (!Array.isArray(db.analysesByUser[req.userId])) {
      db.analysesByUser[req.userId] = [];
    }

    const item = {
      id: uuidv4(),
      summary:   result.summary,
      focus:     result.focus,
      drills:    result.drills,
      comps:     result.comps,
      video_url: videoUrl,
      public_id: publicId || null,
      skill:     skill || profile.skill || null,
      raw:       result.raw,
      created_at: Date.now(),
    };

    db.analysesByUser[req.userId].unshift(item);
    saveDB();

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
    // More specific error text for the frontend
    res.status(500).json({
      ok: false,
      error:
        'Analysis failed on the server. Try again with a shorter clip or try re-uploading.',
      detail: e.message || String(e),
    });
  }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { playerContext, clipsNotes } = req.body;

    if (!playerContext || !clipsNotes) {
      return res.status(400).json({
        ok: false,
        error: "Missing playerContext or clipsNotes"
      });
    }

    const prompt = `
You are a professional soccer coach and performance analyst.

PLAYER CONTEXT:
${JSON.stringify(playerContext, null, 2)}

CLIP NOTES (timestamps + observations):
${JSON.stringify(clipsNotes, null, 2)}

Return VALID JSON ONLY with this structure:
{
  "strengths": [],
  "improvements": [],
  "coachingCues": [],
  "drills": [
    {
      "name": "",
      "setup": "",
      "reps": "",
      "coachingPoints": []
    }
  ],
  "twoWeekPlan": [
    {
      "day": "",
      "focus": "",
      "drills": []
    }
  ]
}
`;

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Output only valid JSON. No markdown. No extra text." },
        { role: "user", content: prompt }
      ],
      temperature: 0.4
    });

    const raw = out.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.json({ ok: true, report: { raw } }); // fallback so it never crashes
    }
    return res.json({ ok: true, report: parsed });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

/* ---------- Start server ---------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BallKnowledge backend running on ${PORT}`);
});
