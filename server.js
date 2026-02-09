/**
 * SOTA Soccer Coordinator Analysis Platform
 * 
 * AI-powered video analysis tool for soccer talent evaluation.
 * Analyzes game and training footage to generate quantified metrics.
 * 
 * Features:
 * - Game footage analysis (pass completion, first touch, game awareness, defense)
 * - Training footage analysis (technical execution, movement quality, consistency)
 * - AI-extracted highlights (best 3-5 moments with timestamps)
 * - Coordinator-focused single candidate evaluation
 * - RESTful API with JWT authentication
 * 
 * Tech Stack:
 * - Express.js for HTTP server
 * - OpenAI GPT-4o for vision analysis
 * - Cloudinary for video hosting
 * - JSON persistence (upgrade to PostgreSQL for production)
 * 
 * Start: npm start (port 3001)
 * Docs: See README.md
 */

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
import os from 'os';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

dotenv.config();

// Configure FFmpeg to use the static binary
ffmpeg.setFfmpegPath(ffmpegStatic);

/* ---------- ENV + constants ---------- */
const JWT_SECRET  = process.env.JWT_SECRET || 'dev_secret_change_me';
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';
const APP_ORIGINS = (process.env.APP_ORIGINS ||
  'https://smusoni.github.io,http://localhost:8080,http://localhost:3000,http://localhost:8080')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PORT = process.env.PORT || 3001;

/* ---------- Express setup ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// Configure multer for file uploads (store in temp folder)
// Use /tmp on Vercel (serverless), or local uploads folder otherwise
const uploadDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files allowed'));
    }
  }
});

app.use(cors({ origin: APP_ORIGINS }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static('.'));

/* ---------- Tiny JSON "DB" ---------- */
// Use /tmp on Vercel (serverless), or local data folder otherwise
const DATA_DIR  = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');

/* ---------- Analytics Cache ---------- */
let analyticsCache = {
  totalUsers: 0,
  totalAnalyses: 0,
  gameAnalyses: 0,
  trainingAnalyses: 0,
  avgCompletionRate: 0,
  dailyActiveUsers: 0,
  weeklyTrend: [],
  lastUpdated: 0
};
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],              // [{id,name,email,passHash,age,dob,createdAt}]
  coordinators: {},       // userId -> {name, organization, role}
  candidates: {},         // userId -> {candidateName, position, age, height, weight, foot, jerseyNumber}
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
      console.error('[SOTA] loadDB error', e);
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
    try { write(); } catch (e) { console.error('[SOTA] saveDB', e); }
    saveTimer = null;
  }, 250);
}

loadDB();

/* ---------- Analytics Functions ---------- */
function refreshAnalyticsCache() {
  try {
    // Total users
    analyticsCache.totalUsers = Array.isArray(db.users) ? db.users.length : Object.keys(db.users || {}).length;
    
    // Analyses stats
    let totalAnalyses = 0;
    let gameCount = 0;
    let trainingCount = 0;
    
    for (const userId in db.analysesByUser || {}) {
      const userAnalyses = db.analysesByUser[userId] || [];
      totalAnalyses += userAnalyses.length;
      
      userAnalyses.forEach(a => {
        if (a.videoType === 'game') gameCount++;
        else if (a.videoType === 'training') trainingCount++;
      });
    }
    
    analyticsCache.totalAnalyses = totalAnalyses;
    analyticsCache.gameAnalyses = gameCount;
    analyticsCache.trainingAnalyses = trainingCount;
    analyticsCache.avgCompletionRate = totalAnalyses > 0 ? 100 : 0;
    
    // Daily active users (last 24 hours)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    let activeUsers = new Set();
    
    for (const userId in db.analysesByUser || {}) {
      const userAnalyses = db.analysesByUser[userId] || [];
      const hasRecent = userAnalyses.some(a => a.createdAt > oneDayAgo);
      if (hasRecent) activeUsers.add(userId);
    }
    
    analyticsCache.dailyActiveUsers = activeUsers.size;
    
    // Weekly trend (last 7 days)
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = Date.now() - (i * 24 * 60 * 60 * 1000);
      const dayEnd = dayStart + (24 * 60 * 60 * 1000);
      
      let dayCount = 0;
      for (const userId in db.analysesByUser || {}) {
        const userAnalyses = db.analysesByUser[userId] || [];
        dayCount += userAnalyses.filter(a => 
          a.createdAt >= dayStart && a.createdAt < dayEnd
        ).length;
      }
      
      trend.push({ date: new Date(dayStart).toISOString().split('T')[0], count: dayCount });
    }
    
    analyticsCache.weeklyTrend = trend;
    analyticsCache.lastUpdated = Date.now();
    
    console.log('📊 Analytics cache refreshed');
  } catch (err) {
    console.error('Analytics cache refresh error:', err);
  }
}

function onAnalysisCompleted() {
  refreshAnalyticsCache();
}

// Refresh analytics cache on startup
refreshAnalyticsCache();

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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Video Frame Extraction (10 frames per video) ---------- */
async function extractFramesFromVideo(videoUrl, duration) {
  try {
    const frames = [];
    
    if (!videoUrl) {
      return null;
    }

    // For Cloudinary URLs: use so_(time_in_seconds) to extract frame at specific timestamp
    if (videoUrl.includes('cloudinary')) {
      const timestamps = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      
      for (const time of timestamps) {
        try {
          const frameUrl = videoUrl.replace(
            /\/upload\//,
            `/upload/so_${time * (duration || 10)},w_800,c_scale,q_80,f_jpg/`
          );
          frames.push({ timestamp: time, url: frameUrl });
        } catch (e) {
          console.log(`[Ball Knowledge] Could not create frame URL for time ${time}`);
        }
      }
      return frames.length > 0 ? frames : null;
    }
    
    // For local file:// URLs: extract frames using FFmpeg
    if (videoUrl.startsWith('file://')) {
      const filePath = videoUrl.replace('file://', '');
      console.log(`[Ball Knowledge] Extracting frames from local file: ${filePath}`);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.error(`[Ball Knowledge] File not found: ${filePath}`);
        return null;
      }
      
      const videoDuration = duration || 10;
      const numFrames = 10;
      const timestamps = [];
      
      // Calculate timestamps to extract (evenly distributed)
      for (let i = 1; i <= numFrames; i++) {
        timestamps.push((i / (numFrames + 1)) * videoDuration);
      }
      
      // Extract frames using FFmpeg
      for (const time of timestamps) {
        try {
          const outputPath = path.join(__dirname, 'uploads', `frame_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`);
          
          await new Promise((resolve, reject) => {
            ffmpeg(filePath)
              .seekInput(time)
              .frames(1)
              .output(outputPath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });
          
          // Read frame and convert to base64
          const frameBuffer = fs.readFileSync(outputPath);
          const base64Frame = `data:image/jpeg;base64,${frameBuffer.toString('base64')}`;
          frames.push({ timestamp: time / videoDuration, base64: base64Frame });
          
          // Clean up temporary frame file
          fs.unlinkSync(outputPath);
          
        } catch (e) {
          console.error(`[Ball Knowledge] Error extracting frame at ${time}s:`, e.message);
        }
      }
      
      console.log(`[Ball Knowledge] Extracted ${frames.length} frames from local video`);
      return frames.length > 0 ? frames : null;
    }
    
    // For other sources: return null
    return null;
  } catch (err) {
    console.error('[Ball Knowledge] Error extracting video frames:', err.message);
    return null;
  }
}

/* ---------- Game Metrics Analysis (GPT-4o with vision) ---------- */
async function analyzeGameMetrics(videoUrl, frames, candidateName, position, duration) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured. Real analysis requires a valid OPENAI_API_KEY environment variable.');
  }

  const messageContent = [
    {
      type: 'text',
      text: `You are a professional soccer match analyst evaluating a player's game performance.

PLAYER: ${candidateName || 'Unknown'} | POSITION: ${position || 'Unknown'} | MATCH DURATION: ${duration || 10} seconds

CRITICAL: Focus on STATISTICAL METRICS and QUANTIFIABLE ACTIONS.

Analyze this game video and provide detailed performance metrics:

1. PASSING METRICS:
   - Total pass attempts
   - Completed passes
   - Pass completion percentage
   - Key passes that led to chances
   - Any missed passes or turnovers

2. SHOOTING METRICS (if applicable):
   - Shot attempts
   - Shots on target
   - Goals scored
   - Shot accuracy percentage

3. DEFENSIVE ACTIONS (if applicable):
   - Tackles attempted and won
   - Interceptions made
   - Clearances made
   - Success rate of defensive actions

4. BALL CONTROL:
   - Estimated number of touches
   - Quality of first touch
   - Successful dribbles attempted

5. POSITIONING & GAME AWARENESS:
   - Movement off the ball
   - Positioning quality (1-10)

6. OVERALL PERFORMANCE:
   - Player grade (1-10)
   - Key strengths shown
   - Areas for improvement
   - Match summary

Be specific with numbers and statistics. Base analysis on what's visible in the video.
Return STRICT JSON ONLY with no markdown or extra text:
{
  "playerStats": {"passes": 0, "shots": 0, "tackles": 0, "interceptions": 0, "fouls": 0},
  "passMetrics": {"attempts": 0, "completed": 0, "accuracy": 0, "keyPasses": 0},
  "shotMetrics": {"attempts": 0, "onTarget": 0, "goals": 0, "accuracy": 0},
  "defensiveMetrics": {"tackles": 0, "interceptions": 0, "clearances": 0, "successRate": 0},
  "ballControl": {"touches": 0, "possessionTime": 0, "successPercentage": 0},
  "positioning": {"grade": 7, "notes": "Assessment of positioning"},
  "strengths": ["Strength 1", "Strength 2"],
  "areasToImprove": ["Area 1", "Area 2"],
  "playerGrade": 7,
  "summary": "Overall match performance assessment"
}`
    }
  ];

  // Add frame images if available
  if (frames && frames.length > 0) {
    for (const frame of frames) {
      if (frame.base64) {
        // Base64 encoded frame from local video extraction
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.base64 }
        });
      } else if (frame.url) {
        // URL-based frame from Cloudinary
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.url }
        });
      }
    }
  }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0.5,
      max_completion_tokens: 8000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no backticks, no extra text. Focus on statistics and quantifiable metrics.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{}';
    let data = {};
    try {
      // Try to extract JSON from markdown code blocks first
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log('[Ball Knowledge] Game metrics JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch (e) {
          console.log('[Ball Knowledge] Regex extraction also failed:', e.message);
          console.log('[Ball Knowledge] Raw content preview:', rawContent.substring(0, 500));
        }
      }
    }

    return {
      playerStats: data.playerStats || {},
      passMetrics: data.passMetrics || {},
      shotMetrics: data.shotMetrics || {},
      defensiveMetrics: data.defensiveMetrics || {},
      ballControl: data.ballControl || {},
      positioning: data.positioning || {},
      strengths: data.strengths || [],
      areasToImprove: data.areasToImprove || [],
      playerGrade: data.playerGrade,
      summary: data.summary
    };
  } catch (error) {
    console.error('[Ball Knowledge] Game analysis error:', error.message);
    throw error;
  }
}

/* ---------- Training Metrics Analysis (GPT-4o with vision) ---------- */
async function analyzeTraining(videoUrl, frames, candidateName, position, duration) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured. Real analysis requires a valid OPENAI_API_KEY environment variable.');
  }

  const messageContent = [
    {
      type: 'text',
      text: `You are an elite professional soccer coach analyzing ${candidateName || 'a player'}'s training session.

PLAYER: ${candidateName || 'Unknown'} | POSITION: ${position || 'Unknown'} | SESSION DURATION: ${duration || 10} seconds

CRITICAL ANALYSIS REQUIREMENTS:
You are analyzing video frames captured throughout this training session. Study ALL frames sequentially to understand:
- Repetition patterns and session progression
- How the skill execution changes from start to finish
- Technical execution details frame-by-frame
- Body positioning, footwork, timing, and follow-through
- Consistency across multiple attempts
- Fatigue impact on technique

SPECIFIC SKILL IDENTIFICATION:
Identify the EXACT skill(s) being worked on from these categories:
- Ball control: first touch, trapping, cushioning
- Passing: short/long passes, accuracy, weight/spin
- Dribbling: close control, speed dribbling, change of direction
- Shooting: technique, power, accuracy, weak foot
- Headers: power, accuracy, heading technique
- Free kicks: curling, accuracy, technique
- Agility: footwork drills, cone drills, change of pace
- Game-specific: transition play, movement off-ball, positioning

DETAILED OBSERVATIONS REQUIRED:
1. What is the PRIMARY skill focus? (one main skill)
2. What are SECONDARY skills being developed?
3. Analyze EXECUTION across all frames:
   - Foot/body positioning at each phase
   - Weight transfer and balance
   - Follow-through completion
   - Consistency across attempts (% success rate observed)
4. PROGRESSION PATTERN in the session:
   - Did difficulty/complexity increase?
   - Did speed/intensity increase?
   - Did accuracy improve or degrade?
   - Are there signs of fatigue affecting form?
5. CURRENT TECHNICAL LEVEL (1-10):
   - 1-3: Beginner (struggling with basics, poor form)
   - 4-6: Intermediate (consistent but inconsistent, minor form issues)
   - 7-8: Advanced (solid technique, mostly consistent, minor refinements needed)
   - 9-10: Elite (exceptional technique, very consistent, professional level)

IMPROVEMENT ANALYSIS:
- Identify the 4 MOST impactful technique improvements needed
- Explain WHY each improvement will have the biggest impact
- Provide exact cues for how to fix each issue
- Order by priority (highest impact first)

COMMON MISTAKES IN THIS SPECIFIC POSITION:
- Identify mistakes specific to ${position || 'this position'}
- Note which mistakes you observed in this player

PROGRESSIONS - Must be realistic and skill-specific:
- Beginner: Simple isolated drill, low speed, controlled
- Intermediate: Add complexity, increase speed, add constraints
- Advanced: Game-realistic, high speed, decision-making

Return STRICT JSON ONLY - no markdown, no backticks:
{
  "skillFocus": "Primary skill being trained",
  "secondarySkills": ["secondary skill 1", "secondary skill 2"],
  "technicalAnalysis": {
    "footwork": "Detailed observation of footwork/positioning",
    "bodyPosition": "How body is positioned throughout execution",
    "followThrough": "Quality of follow-through",
    "consistency": "Consistency across attempts (percentage or description)",
    "sessionProgression": "How the execution changed throughout the session",
    "fatigueImpact": "Did fatigue affect technique? How?"
  },
  "currentLevel": {
    "grade": 6,
    "description": "Specific description with concrete examples from video"
  },
  "improvementTips": [
    {"priority": 1, "tip": "Specific improvement", "why": "Why this matters most", "how": "Exact cue or drill"},
    {"priority": 2, "tip": "Specific improvement", "why": "Why this matters", "how": "Exact cue or drill"},
    {"priority": 3, "tip": "Specific improvement", "why": "Why this matters", "how": "Exact cue or drill"},
    {"priority": 4, "tip": "Specific improvement", "why": "Why this matters", "how": "Exact cue or drill"}
  ],
  "commonMistakesForPosition": [
    {"mistake": "Common ${position || 'position'} mistake", "observed": true/false, "correction": "How to fix"},
    {"mistake": "Common ${position || 'position'} mistake", "observed": true/false, "correction": "How to fix"}
  ],
  "practiceProgression": [
    {"level": "Beginner", "drill": "Detailed beginner drill specific to this skill"},
    {"level": "Intermediate", "drill": "Detailed intermediate progression"},
    {"level": "Advanced", "drill": "Detailed advanced game-realistic progression"}
  ],
  "youtubeRecommendations": [
    {"title": "Specific video title", "coach": "Coach/Channel", "why": "Exact reason this helps with identified weaknesses"},
    {"title": "Specific video title", "coach": "Coach/Channel", "why": "Exact reason this helps with identified weaknesses"},
    {"title": "Specific video title", "coach": "Coach/Channel", "why": "Exact reason this helps with identified weaknesses"}
  ],
  "sessionSummary": "Detailed assessment including: what was trained well, what needs work, overall session quality, and primary focus for next session"
}`
    }
  ];

  if (frames && frames.length > 0) {
    for (const frame of frames) {
      if (frame.base64) {
        // Base64 encoded frame from local video extraction
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.base64 }
        });
      } else if (frame.url) {
        // URL-based frame from Cloudinary
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.url }
        });
      }
    }
  }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0.5,
      max_completion_tokens: 8000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no backticks, no extra text. Must identify the specific skill being trained.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{}';
    let data = {};
    try {
      // Try to extract JSON from markdown code blocks first
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log('[Ball Knowledge] Training analysis JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch (e) {
          console.log('[Ball Knowledge] Regex extraction also failed:', e.message);
          console.log('[Ball Knowledge] Raw content preview:', rawContent.substring(0, 500));
        }
      }
    }

    return {
      skillFocus: data.skillFocus,
      secondarySkills: data.secondarySkills || [],
      technicalAnalysis: data.technicalAnalysis || {},
      currentLevel: data.currentLevel || {},
      improvementTips: data.improvementTips || [],
      commonMistakesForPosition: data.commonMistakesForPosition || [],
      practiceProgression: data.practiceProgression || [],
      youtubeRecommendations: data.youtubeRecommendations || [],
      sessionSummary: data.sessionSummary
    };
  } catch (error) {
    console.error('[Ball Knowledge] Training analysis error:', error.message);
    throw error;
  }
}

/* ---------- AI Highlight Extraction (GPT-4o-mini) ---------- */
async function extractHighlights(videoUrl, frames, candidateName, videoType) {
  if (!openai) {
    throw new Error('OpenAI client not initialized. Real highlight extraction requires a valid OPENAI_API_KEY environment variable.');
  }

  const messageContent = [
    {
      type: 'text',
      text: `Identify the 3-5 BEST moments from ${candidateName}'s ${videoType} video.

For each highlight:
- Identify the frame/timestamp (0-1.0 scale)
- Describe what happens
- Explain why it's notable
- Categorize (pass, dribble, shot, defense, awareness, etc.)

Return STRICT JSON ONLY:
{
  "highlights": [
    {"timestamp": 0.0, "description": "", "why": "", "category": ""}
  ]
}`
    }
  ];

  if (frames && frames.length > 0) {
    for (const frame of frames.slice(0, 8)) {
      if (frame.base64) {
        // Base64 encoded frame from local video extraction
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.base64 }
        });
      } else if (frame.url) {
        // URL-based frame from Cloudinary
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.url }
        });
      }
    }
  }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0.3,
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{"highlights": []}';
    let data = {};
    try {
      // Try to extract JSON from markdown code blocks first
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log('[Ball Knowledge] Highlights JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch (e) {
          console.log('[Ball Knowledge] Regex extraction also failed:', e.message);
          console.log('[Ball Knowledge] Raw content preview:', rawContent.substring(0, 500));
        }
      }
    }

    return data.highlights || [];
  } catch (error) {
    console.error('[SOTA] Highlight extraction error:', error.message);
    throw error;
  }
}


/* ---------- Misc Endpoints ---------- */
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
      return res.status(400).json({ ok: false, error: 'OpenAI API key not configured' });
    }
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'You are a helpful soccer coach.' },
        { role: 'user', content: 'Give me one quick soccer training tip in 2 sentences.' },
      ],
    });
    const message = resp.choices?.[0]?.message?.content || 'No response';
    res.json({ ok: true, message: message, model: resp.model, usage: resp.usage });
  } catch (error) {
    console.error('[SOTA] test-openai error:', error.message);
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
      { expiresIn: '90d' },
    );
    res.json({
      ok: true,
      token,
      user: { id, name: user.name, email: user.email },
    });
  } catch (e) {
    console.error('[SOTA] signup', e);
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
      { expiresIn: '90d' },
    );
    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (e) {
    console.error('[SOTA] login', e);
    res.status(500).json({ ok: false, error: 'Server error (login)' });
  }
});

app.get('/api/me', auth, (req, res) => {
  const u = findUserById(req.userId);
  if (!u) return res.status(404).json({ ok: false, error: 'User not found' });
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email } });
});

/* ==================================================================== */
/*                           COORDINATOR PROFILE                        */
/* ==================================================================== */

app.post('/api/coordinator', auth, (req, res) => {
  const { coordinatorName, organization, role } = req.body || {};
  if (!db.coordinators) db.coordinators = {};
  db.coordinators[req.userId] = {
    coordinatorName: coordinatorName || null,
    organization: organization || null,
    role: role || null,
    updatedAt: Date.now()
  };
  saveDB();
  res.json({ ok: true, profile: db.coordinators[req.userId] });
});

app.get('/api/coordinator', auth, (req, res) => {
  const profile = (db.coordinators || {})[req.userId] || {};
  res.json({ ok: true, profile });
});

/* ==================================================================== */
/*                           CANDIDATE PROFILE                          */
/* ==================================================================== */

app.post('/api/candidate', auth, (req, res) => {
  const { candidateName, position, age, height, weight, foot, jerseyNumber } = req.body || {};
  if (!db.candidates) db.candidates = {};
  db.candidates[req.userId] = {
    candidateName: candidateName || null,
    position: position || null,
    age: age ? Number(age) : null,
    height: height ? Number(height) : null,
    weight: weight ? Number(weight) : null,
    foot: foot || null,
    jerseyNumber: jerseyNumber ? Number(jerseyNumber) : null,
    updatedAt: Date.now()
  };
  saveDB();
  res.json({ ok: true, candidate: db.candidates[req.userId] });
});

app.get('/api/candidate', auth, (req, res) => {
  const candidate = (db.candidates || {})[req.userId] || {};
  res.json({ ok: true, candidate });
});

/* ==================================================================== */
/*                           UNIFIED PROFILE                            */
/* ==================================================================== */

app.get('/api/profile', auth, (req, res) => {
  const user = Array.isArray(db.users) ? db.users.find(u => u.id === req.userId) : db.users[req.userId];
  const coordinator = (db.coordinators || {})[req.userId] || {};
  const candidate = (db.candidates || {})[req.userId] || {};
  
  res.json({ 
    ok: true, 
    user: { email: user?.email },
    coordinator,
    candidate
  });
});

app.post('/api/profile', auth, (req, res) => {
  const { coordinator, candidate } = req.body || {};
  
  // Update coordinator if provided
  if (coordinator) {
    if (!db.coordinators) db.coordinators = {};
    db.coordinators[req.userId] = {
      coordinatorName: coordinator.coordinatorName || null,
      organization: coordinator.organization || null,
      role: coordinator.role || null,
      updatedAt: Date.now()
    };
  }
  
  // Update candidate if provided
  if (candidate) {
    if (!db.candidates) db.candidates = {};
    db.candidates[req.userId] = {
      candidateName: candidate.candidateName || null,
      position: candidate.position || null,
      age: candidate.age ? Number(candidate.age) : null,
      height: candidate.height ? Number(candidate.height) : null,
      weight: candidate.weight ? Number(candidate.weight) : null,
      foot: candidate.foot || null,
      jerseyNumber: candidate.jerseyNumber ? Number(candidate.jerseyNumber) : null,
      updatedAt: Date.now()
    };
  }
  
  saveDB();
  
  res.json({ 
    ok: true, 
    coordinator: db.coordinators[req.userId] || {},
    candidate: db.candidates[req.userId] || {}
  });
});

/* ==================================================================== */
/*                              ANALYSIS                                */
/* ==================================================================== */

app.post('/api/analyze', auth, upload.single('file'), async (req, res) => {
  try {
    const videoType = req.body.videoType;
    const candidateInfoStr = req.body.candidateInfo;
    const candidateInfo = candidateInfoStr ? JSON.parse(candidateInfoStr) : {};
    
    let videoUrl;
    let videoDuration = Number(req.body.duration) || 10;

    // Handle file upload
    if (req.file) {
      const filePath = req.file.path;
      videoUrl = 'file://' + filePath;
      console.log(`[Ball Knowledge] File uploaded: ${req.file.filename} (${req.file.size} bytes)`);
    } else {
      // Handle URL submission
      videoUrl = req.body.videoUrl?.trim();
      videoDuration = Number(req.body.duration) || 60;
    }

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Video URL or file required' });
    }
    if (!['game', 'training'].includes(videoType)) {
      return res.status(400).json({ ok: false, error: 'videoType must be "game" or "training"' });
    }

    console.log(`[Ball Knowledge] Starting ${videoType} analysis`);
    
    const candidateName = candidateInfo.name || 'Unknown Player';
    const position = candidateInfo.position || 'Unknown';
    const frames = await extractFramesFromVideo(videoUrl, videoDuration);
    console.log(`[Ball Knowledge] Extracted ${frames ? frames.length : 0} frames from video`);
    
    let analysis = {};
    console.log(`[Ball Knowledge] Calling ${videoType === 'game' ? 'analyzeGameMetrics' : 'analyzeTraining'}...`);
    if (videoType === 'game') {
      analysis = await analyzeGameMetrics(videoUrl, frames, candidateName, position, videoDuration);
    } else {
      analysis = await analyzeTraining(videoUrl, frames, candidateName, position, videoDuration);
    }
    console.log(`[Ball Knowledge] ${videoType} analysis completed`);
    
    console.log(`[Ball Knowledge] Extracting highlights...`);
    const highlights = await extractHighlights(videoUrl, frames, candidateName, videoType);
    console.log(`[Ball Knowledge] Highlights extraction completed`);
    
    if (!Array.isArray(db.analysesByUser[req.userId])) {
      db.analysesByUser[req.userId] = [];
    }
    
    const item = {
      id: uuidv4(),
      videoType: videoType,
      videoUrl: videoUrl,
      candidateName: candidateName,
      position: position,
      analysis: analysis,
      highlights: highlights,
      createdAt: Date.now(),
    };
    
    db.analysesByUser[req.userId].unshift(item);
    saveDB();
    
    // Refresh analytics cache
    onAnalysisCompleted();
    
    // Clean up uploaded file if needed
    if (req.file && process.env.DELETE_UPLOADS !== 'false') {
      setTimeout(() => {
        try { fs.unlinkSync(req.file.path); } catch (e) { }
      }, 5000);
    }
    
    res.json({
      ok: true,
      id: item.id,
      videoType: item.videoType,
      candidateName: item.candidateName,
      position: item.position,
      analysis: item.analysis,
      highlights: item.highlights,
      createdAt: item.createdAt,
      summary: analysis.summary || analysis.sessionSummary,
      // Flattened fields for easier frontend access
      skillFocus: analysis.skillFocus,
      currentLevel: analysis.currentLevel,
      improvementTips: analysis.improvementTips,
      technicalAnalysis: analysis.technicalAnalysis,
      practiceProgression: analysis.practiceProgression,
      youtubeRecommendations: analysis.youtubeRecommendations,
      strengths: analysis.strengths,
      areasToImprove: analysis.areasToImprove,
      playerGrade: analysis.playerGrade
    });
  } catch (e) {
    console.error('[Ball Knowledge] analyze error:', e.message);
    console.error('[Ball Knowledge] Full error:', e);
    res.status(500).json({
      ok: false,
      error: 'Analysis failed. Please try again.',
      detail: e.message
    });
  }
});

/* ==================================================================== */
/*                              LIBRARY                                 */
/* ==================================================================== */

app.get('/api/analyses', auth, (req, res) => {
  const analyses = db.analysesByUser[req.userId] || [];
  res.json({ ok: true, analyses, items: analyses });
});

app.get('/api/analyses/:id', auth, (req, res) => {
  const analyses = db.analysesByUser[req.userId] || [];
  const item = analyses.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Analysis not found' });
  
  // Include flattened fields for easier frontend consumption
  res.json({ 
    ok: true, 
    analysis: item,
    ...item,
    skillFocus: item.analysis?.skillFocus,
    currentLevel: item.analysis?.currentLevel,
    improvementTips: item.analysis?.improvementTips,
    technicalAnalysis: item.analysis?.technicalAnalysis,
    practiceProgression: item.analysis?.practiceProgression,
    youtubeRecommendations: item.analysis?.youtubeRecommendations,
    sessionSummary: item.analysis?.sessionSummary,
    summary: item.analysis?.summary || item.analysis?.sessionSummary,
    strengths: item.analysis?.strengths,
    areasToImprove: item.analysis?.areasToImprove,
    playerGrade: item.analysis?.playerGrade
  });
});

app.delete('/api/analyses/:id', auth, (req, res) => {
  const analyses = db.analysesByUser[req.userId] || [];
  const idx = analyses.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Analysis not found' });
  analyses.splice(idx, 1);
  db.analysesByUser[req.userId] = analyses;
  saveDB();
  onAnalysisCompleted(); // Refresh analytics
  res.json({ ok: true });
});

/* ==================================================================== */
/*                              ANALYTICS                               */
/* ==================================================================== */

// Dashboard analytics (admin view)
app.get('/api/analytics/dashboard', (req, res) => {
  // Refresh cache if older than 5 minutes
  if (Date.now() - analyticsCache.lastUpdated > 5 * 60 * 1000) {
    refreshAnalyticsCache();
  }
  
  res.json({ 
    ok: true, 
    analytics: analyticsCache 
  });
});

// User-specific analytics
app.get('/api/analytics/user', (req, res) => {
  // Get userId from auth or use first user as fallback
  let userId;
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.sub;
    }
  } catch (e) {
    // If no valid token, use first user
    userId = Array.isArray(db.users) && db.users.length > 0 ? db.users[0].id : null;
  }
  
  if (!userId) {
    return res.status(400).json({ ok: false, error: 'No users found' });
  }
  
  const userAnalyses = db.analysesByUser[userId] || [];
  
  // Find user
  const user = Array.isArray(db.users) ? db.users.find(u => u.id === userId) : db.users[userId];
  
  // Calculate user stats
  const stats = {
    totalAnalyses: userAnalyses.length,
    gameAnalyses: userAnalyses.filter(a => a.videoType === 'game').length,
    trainingAnalyses: userAnalyses.filter(a => a.videoType === 'training').length,
    joinedAt: user?.createdAt || Date.now(),
    lastAnalysis: userAnalyses[0]?.createdAt || null
  };
  
  // Skill focus distribution
  const skillFocusCount = {};
  userAnalyses.forEach(a => {
    const focus = a.analysis?.skillFocus;
    if (focus) {
      skillFocusCount[focus] = (skillFocusCount[focus] || 0) + 1;
    }
  });
  
  // Average grades (if available)
  const grades = userAnalyses
    .map(a => a.analysis?.playerGrade)
    .filter(g => g && typeof g === 'number');
  const avgGrade = grades.length > 0 
    ? (grades.reduce((sum, g) => sum + g, 0) / grades.length).toFixed(1)
    : null;
  
  // Weekly activity (last 4 weeks)
  const weeklyActivity = [];
  for (let i = 3; i >= 0; i--) {
    const weekStart = Date.now() - (i * 7 * 24 * 60 * 60 * 1000);
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000);
    
    const weekCount = userAnalyses.filter(a => 
      a.createdAt >= weekStart && a.createdAt < weekEnd
    ).length;
    
    weeklyActivity.push({ 
      week: `Week ${4 - i}`, 
      count: weekCount 
    });
  }
  
  res.json({ 
    ok: true, 
    stats,
    skillFocusDistribution: skillFocusCount,
    averageGrade: avgGrade,
    weeklyActivity,
    recentAnalyses: userAnalyses.slice(0, 5).map(a => ({
      id: a.id,
      videoType: a.videoType,
      candidateName: a.candidateName,
      createdAt: a.createdAt,
      grade: a.analysis?.playerGrade
    }))
  });
});

// Track analytics events
app.post('/api/analytics/event', (req, res) => {
  const { eventType, eventData } = req.body;
  
  // Get userId if available
  let userId = 'anonymous';
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.sub;
    }
  } catch (e) {}
  
  if (!db.analyticsEvents) db.analyticsEvents = [];
  
  db.analyticsEvents.push({
    userId: userId,
    eventType,
    eventData: eventData || {},
    timestamp: Date.now()
  });
  
  // Keep only last 10000 events to prevent bloat
  if (db.analyticsEvents.length > 10000) {
    db.analyticsEvents = db.analyticsEvents.slice(-10000);
  }
  
  saveDB();
  res.json({ ok: true });
});

// Get engagement metrics
app.get('/api/analytics/engagement', (req, res) => {
  const allAnalyses = Object.values(db.analysesByUser || {}).flat();
  
  // Position distribution
  const positionCount = {};
  allAnalyses.forEach(a => {
    const pos = a.position;
    if (pos) positionCount[pos] = (positionCount[pos] || 0) + 1;
  });
  
  // Most analyzed candidates
  const candidateCount = {};
  allAnalyses.forEach(a => {
    const name = a.candidateName;
    if (name && name !== 'Unknown Player') {
      candidateCount[name] = (candidateCount[name] || 0) + 1;
    }
  });
  
  const topCandidates = Object.entries(candidateCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  
  // Time distribution (hour of day)
  const hourDistribution = new Array(24).fill(0);
  allAnalyses.forEach(a => {
    const hour = new Date(a.createdAt).getHours();
    hourDistribution[hour]++;
  });
  
  res.json({ 
    ok: true,
    positionDistribution: positionCount,
    topCandidates,
    hourDistribution,
    totalEngagements: allAnalyses.length
  });
});

/* ---------- Start server ---------- */
if (process.env.VERCEL !== '1') {
  // Only listen on a port in local development, not on Vercel
  app.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    const ipv4Addresses = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ipv4Addresses.push(iface.address);
        }
      }
    }
    const ipUrl = ipv4Addresses.length > 0 ? ipv4Addresses[0] : 'localhost';
    console.log(`🎯 Ball Knowledge running on http://${ipUrl}:${PORT}`);
    console.log(`   On this device: http://127.0.0.1:${PORT}`);
  });
}

// Export for Vercel serverless
export default app;

