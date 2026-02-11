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
const client = openai; // Reuse same client instance

/* ---------- Video Frame Extraction ---------- */
async function downloadVideoFrames(videoUrl, videoData = null) {
  try {
    const frames = [];
    
    // Handle base64 video data from local photo library
    if (videoData && (videoData.startsWith('data:video/') || videoData.startsWith('data:image/'))) {
      console.log('[BK] Processing local video/image data');
      // If it's already an image, use it directly
      if (videoData.startsWith('data:image/')) {
        frames.push(videoData);
        console.log('[BK] Using provided image frame directly');
      } else {
        // For video data, we'd need a video processing library
        // For now, log a warning - frontend should extract frames
        console.warn('[BK] Base64 video data provided but frame extraction not implemented');
        console.warn('[BK] Frontend should extract frames before sending to backend');
      }
    }
    // Handle Cloudinary URLs
    else if (videoUrl && videoUrl.includes('cloudinary')) {
      console.log('[BK] Processing Cloudinary video URL');
      // Extract 10 frames at different timestamps for comprehensive analysis
      const timestamps = ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'];
      
      for (const time of timestamps) {
        try {
          // Cloudinary transformation to extract frame
          const frameUrl = videoUrl.replace(/\/upload\//, 
            `/upload/so_${time},w_800,c_scale,q_80,f_jpg/`);
          
          console.log(`[BK] Fetching frame at ${time}: ${frameUrl.substring(0, 80)}...`);
          
          // Download frame as buffer and convert to base64
          const response = await fetch(frameUrl);
          if (!response.ok) {
            console.warn(`[BK] Failed to fetch frame at ${time}: ${response.status}`);
            continue;
          }
          
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const base64 = buffer.toString('base64');
          
          frames.push(`data:image/jpeg;base64,${base64}`);
          console.log(`[BK] Successfully encoded frame at ${time} (${Math.round(buffer.length/1024)}KB)`);
          
        } catch (e) {
          console.error(`[BK] Error processing frame at ${time}:`, e.message);
        }
      }
    }
    // Handle direct image URLs
    else if (videoUrl && (videoUrl.startsWith('http://') || videoUrl.startsWith('https://'))) {
      console.log('[BK] Processing direct image/video URL');
      try {
        const response = await fetch(videoUrl);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const base64 = buffer.toString('base64');
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          frames.push(`data:${contentType};base64,${base64}`);
          console.log(`[BK] Successfully encoded direct URL (${Math.round(buffer.length/1024)}KB)`);
        }
      } catch (e) {
        console.error('[BK] Error fetching direct URL:', e.message);
      }
    }
    
    console.log(`[BK] Frame extraction complete: ${frames.length} frames extracted`);
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
  
  res.json({ 
    ok: true, 
    user: { 
      id: user.id,
      name: user.name, 
      email: user.email, 
      age: user.age,
      dob: user.dob 
    },
    profile: db.profiles[req.userId] || {} 
  });
});

app.post('/api/profile', auth, (req, res) => {
  const { name, age, dob, position, foot, height, weight } = req.body || {};
  const user = findUserById(req.userId);
  
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  
  // Update user data
  if (name) user.name = name;
  if (age) user.age = Number(age);
  if (dob) user.dob = dob;
  
  // Update profile data
  upsertProfile(req.userId, {
    position: position || null,
    foot: foot || null,
    height: Number(height) || null,
    weight: Number(weight) || null,
  });
  
  saveDB();
  
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

async function runTextAnalysisForTraining({ profile, user, videoUrl, videoData, skill }) {
  if (!openai) {
    throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.');
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

  // Extract video frames from Cloudinary or local data
  console.log(`[BK] Starting frame extraction - videoUrl: ${videoUrl ? videoUrl.substring(0, 100) : 'none'}`);
  const frameUrls = await downloadVideoFrames(videoUrl, videoData);
  
  if (frameUrls && frameUrls.length > 0) {
    console.log(`[BK] Successfully extracted ${frameUrls.length} frames for vision analysis`);
    for (let i = 0; i < frameUrls.length; i++) {
      const framePreview = frameUrls[i].substring(0, 50);
      console.log(`[BK] Adding frame ${i + 1}: ${framePreview}...`);
      messageContent.push({
        type: 'image_url',
        image_url: {
          url: frameUrls[i],
        },
      });
    }
  } else {
    console.warn('[BK] WARNING: No video frames extracted - cannot perform video analysis');
    throw new Error('Failed to extract video frames. Please ensure video is uploaded correctly or try a different video.');
  }

  console.log(`[BK] Sending ${messageContent.length} items to OpenAI (${messageContent.length - 1} frames)`);
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.4,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: messageContent },
    ],
  }).catch(error => {
    console.error('[BK] OpenAI API error:', error.message);
    console.error('[BK] Error details:', error.response?.data || error);
    throw new Error(`OpenAI API failed: ${error.message}`);
  });

  console.log(`[BK] OpenAI response received - Model: ${resp.model}, Tokens: ${resp.usage?.total_tokens}`);
  
  const rawContent = resp.choices?.[0]?.message?.content || '{}';
  const jsonText = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);

  console.log(`[BK] Raw OpenAI response (first 500 chars):`, rawContent.substring(0, 500));

  let data = {};
  try {
    data = JSON.parse(jsonText);
  } catch {
    // Handle ```json blocks
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        data = JSON.parse(m[0]);
      } catch (e) {
        console.error('[BK] Failed to parse extracted JSON');
        throw new Error('Could not analyze video. The AI did not recognize this as a soccer training video.');
      }
    } else {
      console.error('[BK] No JSON found in response');
      throw new Error('Could not analyze video. The AI response was: ' + rawContent.substring(0, 200));
    }
  }

  console.log(`[BK] Parsed analysis - Activity: ${data.activity}, Drills: ${data.drills?.length || 0}`);

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
    activity: data.activity || 'Training session',
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
      videoData,  // Base64 video/image data from local photo library
      skill,
    } = req.body || {};

    console.log(`[BK] Analyze request - videoUrl: ${videoUrl ? 'present' : 'none'}, videoData: ${videoData ? 'present' : 'none'}, skill: ${skill}`);

    if (!videoUrl && !videoData) {
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
      videoData,
      skill: skill || profile.skill || null,
    });

    if (!Array.isArray(db.analysesByUser[req.userId])) {
      db.analysesByUser[req.userId] = [];
    }

    const item = {
      id: uuidv4(),
      activity:  result.activity,
      summary:   result.summary,
      focus:     result.focus,
      drills:    result.drills,
      improvements: result.improvements || [],
      comps:     result.comps,
      video_url: videoUrl,
      public_id: publicId || null,
      skill:     skill || profile.skill || null,
      raw:       result.raw,
      created_at: Date.now(),
    };

    db.analysesByUser[req.userId].unshift(item);
    saveDB();

    console.log(`[BK] Analysis complete for user ${req.userId} - Activity: ${item.activity}`);

    res.json({
      ok: true,
      id: item.id,
      activity: item.activity,
      summary: item.summary,
      focus: item.focus,
      drills: item.drills,
      improvements: item.improvements,
      comps: item.comps,
      videoUrl: item.video_url,
      publicId: item.public_id,
      skill: item.skill,
    });
  } catch (e) {
    console.error('[BK] Analysis error:', e);
    console.error('[BK] Stack trace:', e.stack);
    // More specific error text for the frontend
    res.status(500).json({
      ok: false,
      error: e.message || 'Analysis failed on the server. Try again with a shorter clip or try re-uploading.',
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

    if (!client) {
      return res.status(400).json({
        ok: false,
        error: "OpenAI API key not configured"
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

/* ---------- Global error handlers ---------- */
process.on('uncaughtException', (error) => {
  console.error('[BK] Uncaught Exception:', error);
  console.error('[BK] Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[BK] Unhandled Rejection at:', promise);
  console.error('[BK] Reason:', reason);
});

/* ---------- Start server ---------- */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BK] ✅ Server running on http://localhost:${PORT}`);
  console.log(`[BK] OpenAI configured: ${openai ? 'YES' : 'NO'}`);
  console.log(`[BK] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[BK] Server is listening and ready for requests`);
});

server.on('error', (error) => {
  console.error('[BK] Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`[BK] Port ${PORT} is already in use`);
    process.exit(1);
  }
});

// Keep process alive
setInterval(() => {
  // This prevents the process from exiting
}, 1000000);
