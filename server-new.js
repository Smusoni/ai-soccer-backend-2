/**
 * Ball Knowledge Soccer Coordinator Analysis Platform - PostgreSQL Version
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
 * - PostgreSQL (AWS Aurora) for data persistence
 * 
 * Start: npm start (port 3001)
 * Docs: See README.md
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import https from 'https';
import dotenv from 'dotenv';
import os from 'os';
import pool from './db.js';

dotenv.config();

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

app.use(cors({ origin: APP_ORIGINS }));
app.use(express.json({ limit: "100mb" }));
app.use(express.static('.'));

/* ---------- OpenAI setup ---------- */
let openai = null;
if (OPENAI_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_KEY });
  console.log('✅ OpenAI initialized');
} else {
  console.warn('⚠️  OPENAI_API_KEY not set');
}

/* ---------- Database Helpers ---------- */
async function findUser(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/* ---------- Auth Middleware ---------- */
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (e) {
    console.error('[Ball Knowledge] auth error:', e.message);
    res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

/* ==================================================================== */
/*                        ANALYSIS FUNCTIONS                            */
/* ==================================================================== */

async function extractFramesFromVideo(videoUrl, durationSec = 60) {
  return new Promise((resolve) => {
    const frames = [];
    const totalFrames = Math.min(10, Math.max(5, Math.floor(durationSec / 10)));
    const interval = durationSec / totalFrames;

    https.get(videoUrl, (response) => {
      if (response.statusCode === 200) {
        for (let i = 0; i < totalFrames; i++) {
          const timestamp = i * interval;
          frames.push({
            url: `${videoUrl}#t=${timestamp.toFixed(1)}`,
            timestamp: timestamp.toFixed(1)
          });
        }
        resolve(frames);
      } else {
        console.error('[Ball Knowledge] HTTP error:', response.statusCode);
        resolve([]);
      }
    }).on('error', (err) => {
      console.error('[Ball Knowledge] Frame extraction error:', err.message);
      resolve([]);
    });
  });
}

async function analyzeGameMetrics(videoUrl, frames, candidateName, position, duration) {
  if (!openai) throw new Error('OpenAI not configured');
  
  const messageContent = [];
  const durationMin = (duration / 60).toFixed(1);
  
  messageContent.push({
    type: 'text',
    text: `You are an expert soccer talent evaluator. Analyze this ${durationMin}-minute game footage of ${candidateName}, a ${position}.

Return ONLY valid JSON (no markdown, no code blocks). Schema:
{
  "summary": "2-3 paragraph professional evaluation",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "areasToImprove": ["area 1", "area 2", "area 3"],
  "passCompletion": 85,
  "firstTouch": 78,
  "gameAwareness": 82,
  "defensiveWork": 75,
  "playerGrade": 8.2,
  "detailedAnalysis": {
    "technical": "paragraph on technical skills",
    "tactical": "paragraph on tactical understanding",
    "physical": "paragraph on physical attributes",
    "mental": "paragraph on decision-making"
  }
}`
  });

  if (Array.isArray(frames)) {
    for (const frame of frames.slice(0, 10)) {
      if (frame.base64) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.base64 }
        });
      } else if (frame.url) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.url }
        });
      }
    }
  }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{}';
    let data = {};
    
    try {
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log('[Ball Knowledge] JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch (e) {
          console.log('[Ball Knowledge] Regex extraction failed:', e.message);
        }
      }
    }

    return data;
  } catch (error) {
    console.error('[Ball Knowledge] analyzeGameMetrics error:', error.message);
    throw error;
  }
}

async function analyzeTraining(videoUrl, frames, candidateName, position, duration) {
  if (!openai) throw new Error('OpenAI not configured');
  
  const messageContent = [];
  const durationMin = (duration / 60).toFixed(1);
  
  messageContent.push({
    type: 'text',
    text: `You are an expert soccer training analyst. Analyze this ${durationMin}-minute training footage of ${candidateName}, a ${position}.

Return ONLY valid JSON (no markdown, no code blocks). Schema:
{
  "sessionSummary": "2-3 paragraph professional evaluation of training session",
  "skillFocus": "Primary skill being trained (e.g., 'Dribbling', 'Passing', 'Shooting')",
  "currentLevel": "Beginner | Intermediate | Advanced",
  "technicalAnalysis": "Detailed analysis of technical execution",
  "improvementTips": ["tip 1", "tip 2", "tip 3", "tip 4"],
  "practiceProgression": ["drill 1", "drill 2", "drill 3"],
  "youtubeRecommendations": ["video title 1", "video title 2", "video title 3"]
}`
  });

  if (Array.isArray(frames)) {
    for (const frame of frames.slice(0, 10)) {
      if (frame.base64) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.base64 }
        });
      } else if (frame.url) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.url }
        });
      }
    }
  }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{}';
    let data = {};
    
    try {
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log('[Ball Knowledge] JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch (e) {
          console.log('[Ball Knowledge] Regex extraction failed:', e.message);
        }
      }
    }

    return data;
  } catch (error) {
    console.error('[Ball Knowledge] analyzeTraining error:', error.message);
    throw error;
  }
}

async function extractHighlights(videoUrl, frames, candidateName, videoType) {
  if (!openai) return [];
  
  const messageContent = [];
  const analysisType = videoType === 'game' ? 'game footage' : 'training session';
  
  messageContent.push({
    type: 'text',
    text: `Identify the 3-5 best moments from this ${analysisType} of ${candidateName}.

Return ONLY valid JSON (no markdown, no code blocks). Schema:
{
  "highlights": [
    {
      "timestamp": "0:45",
      "description": "Excellent first touch under pressure",
      "quality": "excellent"
    }
  ]
}`
  });

  if (Array.isArray(frames)) {
    for (const frame of frames.slice(0, 10)) {
      if (frame.base64) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.base64 }
        });
      } else if (frame.url) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: frame.url }
        });
      }
    }
  }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
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
        }
      }
    }

    return data.highlights || [];
  } catch (error) {
    console.error('[Ball Knowledge] Highlight extraction error:', error.message);
    throw error;
  }
}

/* ==================================================================== */
/*                          MISC ENDPOINTS                              */
/* ==================================================================== */

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, uptime: process.uptime(), database: 'PostgreSQL' }),
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
    console.error('[Ball Knowledge] test-openai error:', error.message);
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
    
    const existingUser = await findUser(email);
    if (existingUser) {
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    }
    
    const id = uuidv4();
    const passHash = await bcrypt.hash(String(password), 10);
    
    await pool.query(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [id, String(email).trim().toLowerCase(), passHash]
    );
    
    const token = jwt.sign(
      { sub: id, email: String(email).trim().toLowerCase(), name: String(name).trim() },
      JWT_SECRET,
      { expiresIn: '90d' },
    );
    
    res.json({
      ok: true,
      token,
      user: { id, name: String(name).trim(), email: String(email).trim().toLowerCase() },
    });
  } catch (e) {
    console.error('[Ball Knowledge] signup', e);
    res.status(500).json({ ok: false, error: 'Server error (signup)' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required' });
    }
    
    const user = await findUser(email);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    
    const token = jwt.sign(
      { sub: user.id, email: user.email, name: user.email },
      JWT_SECRET,
      { expiresIn: '90d' },
    );
    
    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.email, email: user.email },
    });
  } catch (e) {
    console.error('[Ball Knowledge] login', e);
    res.status(500).json({ ok: false, error: 'Server error (login)' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const u = await findUserById(req.userId);
    if (!u) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user: { id: u.id, name: u.email, email: u.email } });
  } catch (e) {
    console.error('[Ball Knowledge] /api/me error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                         PROFILE ENDPOINTS                            */
/* ==================================================================== */

app.post('/api/coordinator', auth, async (req, res) => {
  try {
    const { coordinatorName, organization, role } = req.body || {};
    
    await pool.query(
      `INSERT INTO coordinator_profiles (user_id, coordinator_name, organization, role, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         coordinator_name = EXCLUDED.coordinator_name,
         organization = EXCLUDED.organization,
         role = EXCLUDED.role,
         updated_at = NOW()`,
      [req.userId, coordinatorName || null, organization || null, role || null]
    );
    
    res.json({ 
      ok: true, 
      profile: { coordinatorName, organization, role, updatedAt: Date.now() }
    });
  } catch (e) {
    console.error('[Ball Knowledge] coordinator profile error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/coordinator', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT coordinator_name, organization, role, updated_at FROM coordinator_profiles WHERE user_id = $1',
      [req.userId]
    );
    
    const profile = result.rows[0] || {};
    res.json({ ok: true, profile });
  } catch (e) {
    console.error('[Ball Knowledge] get coordinator error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/candidate', auth, async (req, res) => {
  try {
    const { candidateName, position, age, height, weight, foot, jerseyNumber } = req.body || {};
    
    await pool.query(
      `INSERT INTO candidate_profiles (user_id, candidate_name, position, age, height, weight, foot, jersey_number, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         candidate_name = EXCLUDED.candidate_name,
         position = EXCLUDED.position,
         age = EXCLUDED.age,
         height = EXCLUDED.height,
         weight = EXCLUDED.weight,
         foot = EXCLUDED.foot,
         jersey_number = EXCLUDED.jersey_number,
         updated_at = NOW()`,
      [
        req.userId,
        candidateName || null,
        position || null,
        age ? Number(age) : null,
        height ? Number(height) : null,
        weight ? Number(weight) : null,
        foot || null,
        jerseyNumber ? Number(jerseyNumber) : null
      ]
    );
    
    res.json({ 
      ok: true, 
      candidate: { candidateName, position, age, height, weight, foot, jerseyNumber, updatedAt: Date.now() }
    });
  } catch (e) {
    console.error('[Ball Knowledge] candidate profile error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/candidate', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT candidate_name, position, age, height, weight, foot, jersey_number, updated_at FROM candidate_profiles WHERE user_id = $1',
      [req.userId]
    );
    
    const candidate = result.rows[0] || {};
    res.json({ ok: true, candidate });
  } catch (e) {
    console.error('[Ball Knowledge] get candidate error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/profile', auth, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [req.userId]
    );
    
    const coordinatorResult = await pool.query(
      'SELECT coordinator_name, organization, role FROM coordinator_profiles WHERE user_id = $1',
      [req.userId]
    );
    
    const candidateResult = await pool.query(
      'SELECT candidate_name, position, age, height, weight, foot, jersey_number FROM candidate_profiles WHERE user_id = $1',
      [req.userId]
    );
    
    res.json({ 
      ok: true, 
      user: { email: userResult.rows[0]?.email },
      coordinator: coordinatorResult.rows[0] || {},
      candidate: candidateResult.rows[0] || {}
    });
  } catch (e) {
    console.error('[Ball Knowledge] get profile error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/profile', auth, async (req, res) => {
  try {
    const { coordinator, candidate } = req.body || {};
    
    // Update coordinator if provided
    if (coordinator) {
      await pool.query(
        `INSERT INTO coordinator_profiles (user_id, coordinator_name, organization, role, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) 
         DO UPDATE SET 
           coordinator_name = EXCLUDED.coordinator_name,
           organization = EXCLUDED.organization,
           role = EXCLUDED.role,
           updated_at = NOW()`,
        [req.userId, coordinator.coordinatorName || null, coordinator.organization || null, coordinator.role || null]
      );
    }
    
    // Update candidate if provided
    if (candidate) {
      await pool.query(
        `INSERT INTO candidate_profiles (user_id, candidate_name, position, age, height, weight, foot, jersey_number, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           candidate_name = EXCLUDED.candidate_name,
           position = EXCLUDED.position,
           age = EXCLUDED.age,
           height = EXCLUDED.height,
           weight = EXCLUDED.weight,
           foot = EXCLUDED.foot,
           jersey_number = EXCLUDED.jersey_number,
           updated_at = NOW()`,
        [
          req.userId,
          candidate.candidateName || null,
          candidate.position || null,
          candidate.age ? Number(candidate.age) : null,
          candidate.height ? Number(candidate.height) : null,
          candidate.weight ? Number(candidate.weight) : null,
          candidate.foot || null,
          candidate.jerseyNumber ? Number(candidate.jerseyNumber) : null
        ]
      );
    }
    
    const coordinatorResult = await pool.query(
      'SELECT coordinator_name, organization, role FROM coordinator_profiles WHERE user_id = $1',
      [req.userId]
    );
    
    const candidateResult = await pool.query(
      'SELECT candidate_name, position, age, height, weight, foot, jersey_number FROM candidate_profiles WHERE user_id = $1',
      [req.userId]
    );
    
    res.json({ 
      ok: true, 
      coordinator: coordinatorResult.rows[0] || {},
      candidate: candidateResult.rows[0] || {}
    });
  } catch (e) {
    console.error('[Ball Knowledge] update profile error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                              ANALYSIS                                */
/* ==================================================================== */

app.post('/api/analyze', auth, async (req, res) => {
  try {
    const videoType = req.body.videoType;
    const candidateInfo = req.body.candidateInfo || {};
    
    const videoUrl = req.body.videoUrl?.trim();
    const videoDuration = Number(req.body.duration) || 60;

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: 'Video URL required' });
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
    
    const id = uuidv4();
    
    // Save to PostgreSQL
    await pool.query(
      `INSERT INTO analyses (id, user_id, video_type, video_url, candidate_name, position, analysis_data, highlights, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        id,
        req.userId,
        videoType,
        videoUrl,
        candidateName,
        position,
        JSON.stringify(analysis),
        JSON.stringify(highlights)
      ]
    );
    
    res.json({
      ok: true,
      id: id,
      videoType: videoType,
      candidateName: candidateName,
      position: position,
      analysis: analysis,
      highlights: highlights,
      createdAt: Date.now(),
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

app.get('/api/analyses', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, video_type, video_url, candidate_name, position, analysis_data, highlights, created_at
       FROM analyses
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.userId]
    );
    
    const analyses = result.rows.map(row => ({
      id: row.id,
      videoType: row.video_type,
      videoUrl: row.video_url,
      candidateName: row.candidate_name,
      position: row.position,
      analysis: row.analysis_data,
      highlights: row.highlights,
      createdAt: new Date(row.created_at).getTime()
    }));
    
    res.json({ ok: true, analyses, items: analyses });
  } catch (e) {
    console.error('[Ball Knowledge] get analyses error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/analyses/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, video_type, video_url, candidate_name, position, analysis_data, highlights, created_at
       FROM analyses
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Analysis not found' });
    }
    
    const row = result.rows[0];
    const item = {
      id: row.id,
      videoType: row.video_type,
      videoUrl: row.video_url,
      candidateName: row.candidate_name,
      position: row.position,
      analysis: row.analysis_data,
      highlights: row.highlights,
      createdAt: new Date(row.created_at).getTime()
    };
    
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
  } catch (e) {
    console.error('[Ball Knowledge] get analysis by id error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.delete('/api/analyses/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM analyses WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Analysis not found' });
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[Ball Knowledge] delete analysis error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                              ANALYTICS                               */
/* ==================================================================== */

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    // Total users
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(usersResult.rows[0].count);
    
    // Total analyses
    const analysesResult = await pool.query('SELECT COUNT(*) as count FROM analyses');
    const totalAnalyses = parseInt(analysesResult.rows[0].count);
    
    // Game vs Training analyses
    const gameResult = await pool.query("SELECT COUNT(*) as count FROM analyses WHERE video_type = 'game'");
    const trainingResult = await pool.query("SELECT COUNT(*) as count FROM analyses WHERE video_type = 'training'");
    const gameAnalyses = parseInt(gameResult.rows[0].count);
    const trainingAnalyses = parseInt(trainingResult.rows[0].count);
    
    // Daily active users (last 24 hours)
    const dauResult = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM analyses WHERE created_at > NOW() - INTERVAL '24 hours'"
    );
    const dailyActiveUsers = parseInt(dauResult.rows[0].count);
    
    // Weekly trend (last 7 days)
    const weeklyTrend = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = `NOW() - INTERVAL '${i} days'`;
      const dayEnd = `NOW() - INTERVAL '${i - 1} days'`;
      
      const dayResult = await pool.query(
        `SELECT COUNT(*) as count FROM analyses WHERE created_at >= ${dayStart} AND created_at < ${dayEnd}`
      );
      
      const date = new Date();
      date.setDate(date.getDate() - i);
      weeklyTrend.push({
        date: date.toISOString().split('T')[0],
        count: parseInt(dayResult.rows[0].count)
      });
    }
    
    res.json({
      ok: true,
      analytics: {
        totalUsers,
        totalAnalyses,
        gameAnalyses,
        trainingAnalyses,
        avgCompletionRate: totalAnalyses > 0 ? 100 : 0,
        dailyActiveUsers,
        weeklyTrend,
        lastUpdated: Date.now()
      }
    });
  } catch (e) {
    console.error('[Ball Knowledge] dashboard analytics error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/analytics/user', async (req, res) => {
  try {
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
      const firstUserResult = await pool.query('SELECT id FROM users LIMIT 1');
      userId = firstUserResult.rows[0]?.id || null;
    }
    
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'No users found' });
    }
    
    // Get user info
    const userResult = await pool.query('SELECT created_at FROM users WHERE id = $1', [userId]);
    
    // Get user analyses
    const analysesResult = await pool.query(
      `SELECT video_type, analysis_data, created_at
       FROM analyses
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    
    const userAnalyses = analysesResult.rows;
    
    // Calculate stats
    const stats = {
      totalAnalyses: userAnalyses.length,
      gameAnalyses: userAnalyses.filter(a => a.video_type === 'game').length,
      trainingAnalyses: userAnalyses.filter(a => a.video_type === 'training').length,
      joinedAt: userResult.rows[0] ? new Date(userResult.rows[0].created_at).getTime() : Date.now(),
      lastAnalysis: userAnalyses[0] ? new Date(userAnalyses[0].created_at).getTime() : null
    };
    
    // Skill focus distribution
    const skillFocusCount = {};
    userAnalyses.forEach(a => {
      const focus = a.analysis_data?.skillFocus;
      if (focus) {
        skillFocusCount[focus] = (skillFocusCount[focus] || 0) + 1;
      }
    });
    
    // Average grades
    const grades = userAnalyses
      .map(a => a.analysis_data?.playerGrade)
      .filter(g => g && typeof g === 'number');
    const avgGrade = grades.length > 0 
      ? (grades.reduce((sum, g) => sum + g, 0) / grades.length).toFixed(1)
      : null;
    
    // Weekly activity (last 4 weeks)
    const weeklyActivity = [];
    for (let i = 3; i >= 0; i--) {
      const weekStart = Date.now() - (i * 7 * 24 * 60 * 60 * 1000);
      const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000);
      
      const weekCount = userAnalyses.filter(a => {
        const aTime = new Date(a.created_at).getTime();
        return aTime >= weekStart && aTime < weekEnd;
      }).length;
      
      weeklyActivity.push({ 
        week: `Week ${4 - i}`, 
        count: weekCount 
      });
    }
    
    // Recent analyses
    const recentAnalyses = userAnalyses.slice(0, 5).map(a => ({
      id: a.id,
      videoType: a.video_type,
      candidateName: a.candidate_name,
      createdAt: new Date(a.created_at).getTime(),
      grade: a.analysis_data?.playerGrade
    }));
    
    res.json({ 
      ok: true, 
      stats,
      skillFocusDistribution: skillFocusCount,
      averageGrade: avgGrade,
      weeklyActivity,
      recentAnalyses
    });
  } catch (e) {
    console.error('[Ball Knowledge] user analytics error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/analytics/event', async (req, res) => {
  try {
    const { eventType, eventData } = req.body;
    
    // Get userId if available
    let userId = null;
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (token) {
        const payload = jwt.verify(token, JWT_SECRET);
        userId = payload.sub;
      }
    } catch (e) {}
    
    await pool.query(
      'INSERT INTO analytics_events (user_id, event_type, event_data, created_at) VALUES ($1, $2, $3, NOW())',
      [userId, eventType, JSON.stringify(eventData || {})]
    );
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[Ball Knowledge] analytics event error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/analytics/engagement', async (req, res) => {
  try {
    // Position distribution
    const positionResult = await pool.query(
      `SELECT position, COUNT(*) as count
       FROM analyses
       WHERE position IS NOT NULL AND position != 'Unknown'
       GROUP BY position`
    );
    
    const positionCount = {};
    positionResult.rows.forEach(row => {
      positionCount[row.position] = parseInt(row.count);
    });
    
    // Top candidates
    const candidateResult = await pool.query(
      `SELECT candidate_name, COUNT(*) as count
       FROM analyses
       WHERE candidate_name IS NOT NULL AND candidate_name != 'Unknown Player'
       GROUP BY candidate_name
       ORDER BY count DESC
       LIMIT 10`
    );
    
    const topCandidates = candidateResult.rows.map(row => ({
      name: row.candidate_name,
      count: parseInt(row.count)
    }));
    
    // Total engagements
    const totalResult = await pool.query('SELECT COUNT(*) as count FROM analyses');
    const totalEngagements = parseInt(totalResult.rows[0].count);
    
    res.json({ 
      ok: true,
      positionDistribution: positionCount,
      topCandidates,
      totalEngagements
    });
  } catch (e) {
    console.error('[SOTA] engagement analytics error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                          START SERVER                                */
/* ==================================================================== */

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
    console.log(`🎯 Ball Knowledge (PostgreSQL) running on http://${ipUrl}:${PORT}`);
    console.log(`   On this device: http://127.0.0.1:${PORT}`);
  });
}

// Export for Vercel serverless
export default app;
