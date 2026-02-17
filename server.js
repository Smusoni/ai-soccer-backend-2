// server.js — BallKnowledge Part 1 (training-clip, real-time analysis only)
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import os from 'os';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

/* ---------- ENV + constants ---------- */
const JWT_SECRET  = process.env.JWT_SECRET || 'dev_secret_change_me';
const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
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

/* ---------- Token Blacklist ---------- */
const tokenBlacklist = new Set();

/* ---------- Helpers ---------- */
const findUser     = email =>
  db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
const findUserById = id => db.users.find(u => u.id === id);

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
    
    // Check if token is blacklisted
    if (tokenBlacklist.has(token)) {
      return res.status(401).json({ ok: false, error: 'Token has been invalidated' });
    }
    
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    req.token = token; // Store token for logout
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

/* ---------- Gemini AI client ---------- */
const genAI       = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;
const fileManager = GEMINI_KEY ? new GoogleAIFileManager(GEMINI_KEY) : null;

/* ---------- Video helpers for Gemini ---------- */
function detectMimeType(url) {
  if (url.match(/\.mov(\?|$)/i))  return 'video/mov';
  if (url.match(/\.webm(\?|$)/i)) return 'video/webm';
  if (url.match(/\.avi(\?|$)/i))  return 'video/avi';
  return 'video/mp4';
}

async function uploadVideoToGemini(videoUrl, videoData) {
  const tmpPath = path.join(os.tmpdir(), `bk-${Date.now()}.mp4`);
  let mimeType = 'video/mp4';

  try {
    if (videoData && videoData.startsWith('data:video/')) {
      // Base64 video from local upload
      const match = videoData.match(/^data:(video\/[^;]+);base64,(.+)$/);
      if (!match) throw new Error('Invalid base64 video data');
      mimeType = match[1];
      fs.writeFileSync(tmpPath, Buffer.from(match[2], 'base64'));
      console.log(`[BK] Wrote local video to temp file (${mimeType})`);
    } else if (videoUrl) {
      // Download from URL (Cloudinary or direct)
      mimeType = detectMimeType(videoUrl);
      console.log(`[BK] Downloading video from URL (${mimeType})...`);
      const resp = await fetch(videoUrl);
      if (!resp.ok) throw new Error(`Failed to download video: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(tmpPath, buffer);
      console.log(`[BK] Downloaded video: ${Math.round(buffer.length / 1024)}KB`);
    } else {
      throw new Error('No video URL or data provided');
    }

    // Upload to Gemini File API
    console.log('[BK] Uploading video to Gemini...');
    const uploadResult = await fileManager.uploadFile(tmpPath, {
      mimeType,
      displayName: `training-${Date.now()}`,
    });

    // Wait for Gemini to finish processing the video
    let file = uploadResult.file;
    console.log(`[BK] Gemini file state: ${file.state}`);
    while (file.state === 'PROCESSING') {
      await new Promise(r => setTimeout(r, 2000));
      file = await fileManager.getFile(file.name);
      console.log(`[BK] Gemini file state: ${file.state}`);
    }
    if (file.state === 'FAILED') {
      throw new Error('Gemini could not process the video file.');
    }

    console.log(`[BK] Video ready: ${file.uri}`);
    return file;
  } finally {
    // Clean up temp file
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
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

app.post('/api/test-ai', async (req, res) => {
  try {
    if (!genAI) {
      return res.status(400).json({ ok: false, error: 'Gemini API key not configured' });
    }
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent('Give me one quick soccer training tip in 2 sentences.');
    const message = result.response.text();
    res.json({ ok: true, message, model: 'gemini-2.0-flash' });
  } catch (error) {
    console.error('[BK] test-ai error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
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

app.post('/api/logout', auth, (req, res) => {
  try {
    // Add token to blacklist
    if (req.token) {
      tokenBlacklist.add(req.token);
      console.log('[BK] Token blacklisted for user:', req.userId);
    }
    res.json({ ok: true, message: 'Logged out successfully' });
  } catch (e) {
    console.error('[BK] logout', e);
    res.status(500).json({ ok: false, error: 'Server error (logout)' });
  }
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
  const items = (db.analysesByUser[req.userId] || []).map(item => ({
    id: item.id,
    candidateName: item.candidateName || db.profiles[req.userId]?.name || findUserById(req.userId)?.name || "Player",
    videoType: item.videoType || 'training',
    videoUrl: item.video_url,
    publicId: item.public_id,
    skill: item.skill,
    createdAt: item.created_at,
    analysis: item.raw,
    skillFocus: item.skillFocus,
    sessionSummary: item.sessionSummary,
    currentLevel: item.currentLevel,
    technicalAnalysis: item.technicalAnalysis,
    improvementTips: item.improvementTips,
    practiceProgression: item.practiceProgression,
    youtubeRecommendations: item.youtubeRecommendations,
  }));
  res.json({ ok: true, items, analyses: items });
});

app.get('/api/analyses/:id', auth, (req, res) => {
  const list = db.analysesByUser[req.userId] || [];
  const item = list.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });
  
  const levelMap = {
    'Beginner': { grade: '4-5', description: 'Beginner' },
    'Intermediate': { grade: '6-7', description: 'Intermediate' },
    'Advanced': { grade: '8-9', description: 'Advanced' }
  };
  const currentLevelObj = levelMap[item.currentLevel] || { grade: '?', description: item.currentLevel };

  res.json({
    ok: true,
    id: item.id,
    candidateName: item.candidateName || db.profiles[req.userId]?.name || findUserById(req.userId)?.name || "Player",
    videoType: item.videoType || 'training',
    videoUrl: item.video_url,
    publicId: item.public_id,
    skill: item.skill,
    createdAt: item.created_at,
    analysis: item.raw,
    skillFocus: item.skillFocus,
    sessionSummary: item.sessionSummary,
    currentLevel: currentLevelObj,
    technicalAnalysis: item.technicalAnalysis,
    improvementTips: item.improvementTips,
    commonMistakesForPosition: item.commonMistakesForPosition,
    practiceProgression: item.practiceProgression,
    youtubeRecommendations: item.youtubeRecommendations,
  });
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
  if (!genAI || !fileManager) {
    throw new Error('Gemini API key not configured. Please set GEMINI_API_KEY environment variable.');
  }

  const position = profile.position || user?.position || 'player';

  // Upload the actual video to Gemini (native video understanding)
  console.log(`[BK] Uploading video for Gemini analysis...`);
  const file = await uploadVideoToGemini(videoUrl, videoData);

  const prompt = `You are a certified soccer / football coach reviewing a training session video. The player's position is ${position}.

Watch the full video and provide honest, constructive coaching feedback.

Instructions:
1. Identify the drill or activity shown (e.g. juggling, dribbling, passing, shooting, freestyle tricks).
2. Only comment on what is clearly visible. If the camera angle is poor or details are unclear, say so.
3. Do not guess statistics, counts, or measurements you cannot directly observe.
4. Analyze the actual movement, technique, body positioning, and rhythm you see in the video.
5. Give specific, actionable improvement tips based on what you observe.
6. Assess the skill level based on WHAT the player is doing AND how well they execute it:
   - "Beginner": Basic touches, struggling to maintain control, frequent mistakes, simple drills only.
   - "Intermediate": Comfortable with fundamentals, can perform tricks like around-the-world or rainbow flicks, good but inconsistent control, moderate rhythm.
   - "Advanced": Executes complex tricks and skills cleanly (around-the-world, crossovers, akkas, etc.), strong body control, fluid transitions, high consistency, could play at a competitive or semi-pro level.
   If a player is performing freestyle tricks or advanced juggling moves, they are AT LEAST Intermediate. If they do them consistently and fluidly, they are Advanced.

Respond with ONLY valid JSON (no markdown fences, no backticks). Use this exact schema:
{
  "sessionSummary": "2-3 paragraph evaluation of the technique shown",
  "skillFocus": "Primary skill being trained",
  "secondarySkills": ["skill 1", "skill 2"],
  "currentLevel": "Beginner | Intermediate | Advanced",
  "technicalAnalysis": {
    "footwork": "analysis",
    "bodyPosition": "analysis",
    "followThrough": "analysis",
    "consistency": "analysis",
    "sessionProgression": "analysis"
  },
  "improvementTips": [{"priority": 1, "tip": "text", "why": "reason", "how": "instruction"}],
  "commonMistakesForPosition": [{"mistake": "text", "observed": true, "correction": "text"}],
  "practiceProgression": [{"level": "name", "drill": "description"}],
  "youtubeRecommendations": [{"title": "video title", "coach": "channel", "why": "relevance"}]
}`;

  console.log('[BK] Sending video to Gemini 2.0 Flash...');
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const contentParts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ];

  // Retry with backoff for 429 rate-limit errors
  let result;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await model.generateContent(contentParts);
      break;
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries) {
        const waitSec = attempt * 10;
        console.log(`[BK] Rate limited (429). Retry ${attempt}/${maxRetries} in ${waitSec}s...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw err;
      }
    }
  }

  const rawContent = result.response.text();
  console.log(`[BK] Gemini response (first 500 chars):`, rawContent.substring(0, 500));

  let data = {};
  try {
    data = JSON.parse(rawContent);
  } catch {
    const m = rawContent.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        data = JSON.parse(m[0]);
      } catch (e) {
        console.error('[BK] Failed to parse extracted JSON');
        throw new Error('Could not analyze video. The AI did not return valid JSON.');
      }
    } else {
      console.error('[BK] No JSON found in response');
      throw new Error('Could not analyze video. The AI response was: ' + rawContent.substring(0, 200));
    }
  }

  console.log(`[BK] Parsed analysis - Skill: ${data.skillFocus || 'N/A'}, Level: ${data.currentLevel || 'N/A'}`);

  return {
    skillFocus: data.skillFocus || 'Training session',
    secondarySkills: Array.isArray(data.secondarySkills) ? data.secondarySkills : [],
    sessionSummary: data.sessionSummary || 'Training analysis complete.',
    currentLevel: data.currentLevel || 'Intermediate',
    technicalAnalysis: data.technicalAnalysis || {},
    improvementTips: Array.isArray(data.improvementTips) ? data.improvementTips : [],
    commonMistakesForPosition: Array.isArray(data.commonMistakesForPosition) ? data.commonMistakesForPosition : [],
    practiceProgression: Array.isArray(data.practiceProgression) ? data.practiceProgression : [],
    youtubeRecommendations: Array.isArray(data.youtubeRecommendations) ? data.youtubeRecommendations : [],
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

    const candidateName = profile.name?.trim() || user?.name?.trim() || "Player";
    const item = {
      id: uuidv4(),
      candidateName,
      videoType: 'training',
      skillFocus: result.skillFocus,
      secondarySkills: result.secondarySkills,
      sessionSummary: result.sessionSummary,
      currentLevel: result.currentLevel,
      technicalAnalysis: result.technicalAnalysis,
      improvementTips: result.improvementTips,
      commonMistakesForPosition: result.commonMistakesForPosition,
      practiceProgression: result.practiceProgression,
      youtubeRecommendations: result.youtubeRecommendations,
      video_url: videoUrl,
      public_id: publicId || null,
      skill:     skill || profile.skill || null,
      raw:       result.raw,
      created_at: Date.now(),
    };

    db.analysesByUser[req.userId].unshift(item);
    saveDB();

    console.log(`[BK] Analysis complete for user ${req.userId} - Skill: ${item.skillFocus}, Level: ${item.currentLevel}`);

    // Convert currentLevel string to object format for frontend compatibility
    const levelMap = {
      'Beginner': { grade: '4-5', description: item.currentLevel },
      'Intermediate': { grade: '6-7', description: item.currentLevel },
      'Advanced': { grade: '8-9', description: item.currentLevel }
    };
    const currentLevelObj = levelMap[item.currentLevel] || { grade: '?', description: item.currentLevel };

    res.json({
      ok: true,
      id: item.id,
      videoType: 'training',
      videoUrl: item.video_url,
      publicId: item.public_id,
      skill: item.skill,
      createdAt: item.created_at,
      summary: item.sessionSummary,
      analysis: result.raw,
      skillFocus: item.skillFocus,
      secondarySkills: item.secondarySkills,
      sessionSummary: item.sessionSummary,
      currentLevel: currentLevelObj,
      technicalAnalysis: item.technicalAnalysis,
      improvementTips: item.improvementTips,
      commonMistakesForPosition: item.commonMistakesForPosition,
      practiceProgression: item.practiceProgression,
      youtubeRecommendations: item.youtubeRecommendations,
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

    if (!genAI) {
      return res.status(400).json({ ok: false, error: "Gemini API key not configured" });
    }

    const prompt = `You are a professional soccer coach and performance analyst. Output ONLY valid JSON, no markdown, no extra text.

PLAYER CONTEXT:
${JSON.stringify(playerContext, null, 2)}

CLIP NOTES (timestamps + observations):
${JSON.stringify(clipsNotes, null, 2)}

Return VALID JSON ONLY with this structure:
{
  "strengths": [],
  "improvements": [],
  "coachingCues": [],
  "drills": [{ "name": "", "setup": "", "reps": "", "coachingPoints": [] }],
  "twoWeekPlan": [{ "day": "", "focus": "", "drills": [] }]
}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = { raw }; }
      } else {
        parsed = { raw };
      }
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
  console.log(`[BK] Gemini AI configured: ${genAI ? 'YES' : 'NO'}`);
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
