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
 * - PostgreSQL for data persistence
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
import fs from 'fs';
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

/* ---------- Helpers ---------- */
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
      console.log('[Ball Knowledge] [WARNING] No video URL provided');
      return null;
    }

    console.log('[Ball Knowledge] [INFO] Video URL:', videoUrl.substring(0, 100));
    console.log('[Ball Knowledge] [INFO] Video duration:', duration, 'seconds');

    // For Cloudinary URLs: use so_(time_in_seconds) to extract frame at specific timestamp
    if (videoUrl.includes('cloudinary')) {
      console.log('[Ball Knowledge] [SUCCESS] Cloudinary URL detected - extracting frames');
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
      console.log(`[Ball Knowledge] [SUCCESS] Extracted ${frames.length} frames from Cloudinary video`);
      return frames.length > 0 ? frames : null;
    }
    
    // For other video sources (YouTube, Vimeo, etc.): cannot extract frames
    console.log('[Ball Knowledge] [WARNING] Non-Cloudinary URL detected - cannot extract frames');
    console.log('[Ball Knowledge] [WARNING] Video analysis will be TEXT-ONLY (less accurate)');
    return null;
  } catch (err) {
    console.error('[Ball Knowledge] [ERROR] Error extracting video frames:', err.message);
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

${frames && frames.length > 0 ? 'Analyze the provided video frames and provide detailed performance metrics:' : 'IMPORTANT: No video frames available. Provide a TEMPLATE analysis showing typical metrics for a ' + (position || 'player') + ' in a game situation. Use realistic example numbers and make it clear this is a general assessment template.'}

Analyze and provide detailed performance metrics:

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
      model: 'gpt-4o',
      temperature: 0.5,
      max_completion_tokens: 8000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no backticks, no extra text. Focus on statistics and quantifiable metrics.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{}';
    console.log('[Ball Knowledge] [INFO] OpenAI response length:', rawContent.length, 'characters');
    console.log('[Ball Knowledge] [INFO] OpenAI response preview:', rawContent.substring(0, 200));
    
    let data = {};
    try {
      // Try to extract JSON from markdown code blocks first
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
      console.log('[Ball Knowledge] [SUCCESS] Successfully parsed game metrics JSON');
    } catch (parseError) {
      console.log('[Ball Knowledge] [WARNING] Game metrics JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
          console.log('[Ball Knowledge] [SUCCESS] Successfully parsed with regex extraction');
        } catch (e) {
          console.log('[Ball Knowledge] [ERROR] Regex extraction also failed:', e.message);
          console.log('[Ball Knowledge] [ERROR] Raw content preview:', rawContent.substring(0, 500));
          throw new Error('Failed to parse OpenAI response. The AI returned invalid JSON. Raw response: ' + rawContent.substring(0, 200));
        }
      } else {
        console.log('[Ball Knowledge] [ERROR] No JSON object found in response');
        throw new Error('No JSON found in OpenAI response. Raw: ' + rawContent.substring(0, 200));
      }
    }

    // Validate we got at least some meaningful data
    const hasData = data.summary || data.playerGrade || data.playerStats || 
                    (data.strengths && data.strengths.length > 0) || 
                    (data.areasToImprove && data.areasToImprove.length > 0);
    
    if (!hasData) {
      console.log('[Ball Knowledge] [ERROR] OpenAI returned completely empty data');
      console.log('[Ball Knowledge] [ERROR] Response data:', JSON.stringify(data).substring(0, 300));
      throw new Error('OpenAI returned no analysis data. Response may be malformed.');
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
      playerGrade: data.playerGrade || 0,
      summary: data.summary || 'Analysis completed'
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

${frames && frames.length > 0 ? 'CRITICAL ANALYSIS REQUIREMENTS:\nYou are analyzing video frames captured throughout this training session. Study ALL frames sequentially to understand:' : 'IMPORTANT: No video frames available. Provide a COMPREHENSIVE training analysis template with typical skills, improvements, and progressions for a ' + (position || 'player') + '. Make it detailed and actionable even without specific video evidence.'}

${frames && frames.length > 0 ? '' : 'General analysis areas to cover:'}
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
      model: 'gpt-4o',
      temperature: 0.5,
      max_completion_tokens: 8000,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no backticks, no extra text. Must identify the specific skill being trained.' },
        { role: 'user', content: messageContent }
      ]
    });

    const rawContent = resp.choices?.[0]?.message?.content || '{}';
    console.log('[Ball Knowledge] [INFO] OpenAI response length:', rawContent.length, 'characters');
    console.log('[Ball Knowledge] [INFO] OpenAI response preview:', rawContent.substring(0, 200));
    
    let data = {};
    try {
      // Try to extract JSON from markdown code blocks first
      let jsonStr = rawContent;
      if (jsonStr.includes('```')) {
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) jsonStr = codeBlockMatch[1];
      }
      data = JSON.parse(jsonStr);
      console.log('[Ball Knowledge] [SUCCESS] Successfully parsed training analysis JSON');
    } catch (parseError) {
      console.log('[Ball Knowledge] [WARNING] Training analysis JSON parse failed, trying regex extraction...');
      const m = rawContent.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
          console.log('[Ball Knowledge] [SUCCESS] Successfully parsed with regex extraction');
        } catch (e) {
          console.log('[Ball Knowledge] [ERROR] Regex extraction also failed:', e.message);
          console.log('[Ball Knowledge] [ERROR] Raw content preview:', rawContent.substring(0, 500));
          throw new Error('Failed to parse OpenAI response. The AI returned invalid JSON. Raw response: ' + rawContent.substring(0, 200));
        }
      } else {
        console.log('[Ball Knowledge] [ERROR] No JSON object found in response');
        throw new Error('No JSON found in OpenAI response. Raw: ' + rawContent.substring(0, 200));
      }
    }

    // Validate we got at least some meaningful data
    const hasData = data.sessionSummary || data.skillFocus || data.currentLevel || 
                    (data.improvementTips && data.improvementTips.length > 0);
    
    if (!hasData) {
      console.log('[Ball Knowledge] [ERROR] OpenAI returned completely empty data');
      console.log('[Ball Knowledge] [ERROR] Response data:', JSON.stringify(data).substring(0, 300));
      throw new Error('OpenAI returned no analysis data. Response may be malformed.');
    }

    return {
      skillFocus: data.skillFocus || 'General training',
      secondarySkills: data.secondarySkills || [],
      technicalAnalysis: data.technicalAnalysis || {},
      currentLevel: data.currentLevel || { grade: 5, description: 'Intermediate level' },
      improvementTips: data.improvementTips || [],
      commonMistakesForPosition: data.commonMistakesForPosition || [],
      practiceProgression: data.practiceProgression || [],
      youtubeRecommendations: data.youtubeRecommendations || [],
      sessionSummary: data.sessionSummary || 'Training session analyzed'
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

app.post('/api/migrate', async (req, res) => {
  try {
    console.log('[SOTA] Running database migration...');
    const schemaPath = path.join(__dirname, 'migrations', '001_initial_schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);
    console.log('[SOTA] Migration completed successfully');
    res.json({ 
      ok: true, 
      message: 'Database migration completed successfully',
      tables: ['users', 'coordinator_profiles', 'candidate_profiles', 'analyses', 'analytics_events']
    });
  } catch (error) {
    console.error('[SOTA] Migration failed:', error);
    res.status(500).json({ 
      ok: false, 
      error: 'Migration failed', 
      detail: error.message 
    });
  }
});

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
    console.error('[SOTA] login', e);
    res.status(500).json({ ok: false, error: 'Server error (login)' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const u = await findUserById(req.userId);
    if (!u) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user: { id: u.id, name: u.email, email: u.email } });
  } catch (e) {
    console.error('[SOTA] /api/me error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                           COORDINATOR PROFILE                        */
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
    console.error('[SOTA] coordinator profile error:', e);
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
    console.error('[SOTA] get coordinator error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                           CANDIDATE PROFILE                          */
/* ==================================================================== */

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
    console.error('[SOTA] candidate profile error:', e);
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
    console.error('[SOTA] get candidate error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ==================================================================== */
/*                           UNIFIED PROFILE                            */
/* ==================================================================== */

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
    console.error('[SOTA] get profile error:', e);
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
    console.error('[SOTA] update profile error:', e);
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

    console.log(`[Ball Knowledge] [START] Starting ${videoType} analysis`);
    console.log(`[Ball Knowledge] [INFO] Video URL: ${videoUrl.substring(0, 100)}...`);
    console.log(`[Ball Knowledge] [INFO] Duration: ${videoDuration} seconds`);
    
    const candidateName = candidateInfo.name || 'Unknown Player';
    const position = candidateInfo.position || 'Unknown';
    console.log(`[Ball Knowledge] [INFO] Candidate: ${candidateName}, Position: ${position}`);
    
    const frames = await extractFramesFromVideo(videoUrl, videoDuration);
    console.log(`[Ball Knowledge] [INFO] Extracted ${frames ? frames.length : 0} frames from video`);
    
    if (!frames || frames.length === 0) {
      console.log(`[Ball Knowledge] [WARNING] No video frames extracted! Analysis will be text-only and less accurate.`);
      console.log(`[Ball Knowledge] [WARNING] This usually happens with non-Cloudinary URLs (YouTube, Vimeo, etc.)`);
    }
    
    let analysis = {};
    console.log(`[Ball Knowledge] [INFO] Calling ${videoType === 'game' ? 'analyzeGameMetrics' : 'analyzeTraining'}...`);
    if (videoType === 'game') {
      analysis = await analyzeGameMetrics(videoUrl, frames, candidateName, position, videoDuration);
    } else {
      analysis = await analyzeTraining(videoUrl, frames, candidateName, position, videoDuration);
    }
    console.log(`[Ball Knowledge] [SUCCESS] ${videoType} analysis completed`);
    console.log(`[Ball Knowledge] [INFO] Analysis keys:`, Object.keys(analysis));
    
    console.log(`[Ball Knowledge] [INFO] Extracting highlights...`);
    const highlights = await extractHighlights(videoUrl, frames, candidateName, videoType);
    console.log(`[Ball Knowledge] [SUCCESS] Highlights extraction completed (${highlights ? highlights.length : 0} highlights)`);
    
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
    console.error('[SOTA] get analyses error:', e);
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
    console.error('[SOTA] get analysis by id error:', e);
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
    console.error('[SOTA] delete analysis error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
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

