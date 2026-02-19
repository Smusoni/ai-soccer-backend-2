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
import { Resend } from 'resend';
import Stripe from 'stripe';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import os from 'os';
import https from 'https';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

/* ---------- ENV + constants ---------- */
const JWT_SECRET  = process.env.JWT_SECRET || 'dev_secret_change_me';
const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
const RESEND_KEY  = process.env.RESEND_API_KEY || '';
const resend      = RESEND_KEY ? new Resend(RESEND_KEY) : null;
const STRIPE_SECRET    = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUB_KEY   = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_LOOKUP_KEY = 'Training_Video_Analysis_-293c440';
const FREE_ANALYSIS_LIMIT = 2;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
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

// Stripe webhook needs raw body - must be before express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');
  
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[BK] Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[BK] Stripe event: ${event.type}`);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const customerId = session.customer;
    if (userId) {
      try {
        await pool.query(
          'UPDATE users SET subscription_status = $1, stripe_customer_id = $2 WHERE id = $3',
          ['active', customerId, userId]
        );
        console.log(`[BK] User ${userId} subscription activated`);
      } catch (e) { console.error('[BK] Webhook DB error:', e.message); }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    try {
      await pool.query(
        'UPDATE users SET subscription_status = $1 WHERE stripe_customer_id = $2',
        ['cancelled', customerId]
      );
      console.log(`[BK] Subscription cancelled for stripe customer ${customerId}`);
    } catch (e) { console.error('[BK] Webhook DB error:', e.message); }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static('.'));

/* ---------- PostgreSQL DB ---------- */
const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.POSTGRES_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('[BK] WARNING: No POSTGRES_URL or DATABASE_URL env var found. Database will not work.');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        pass_hash TEXT,
        age INTEGER,
        dob TEXT,
        subscription_status TEXT DEFAULT 'free',
        stripe_customer_id TEXT,
        created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      );
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        name TEXT,
        age INTEGER,
        dob TEXT,
        height INTEGER,
        weight TEXT,
        foot TEXT,
        position TEXT,
        skill TEXT,
        updated_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS clips (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        url TEXT,
        public_id TEXT,
        created_at TEXT,
        bytes INTEGER,
        duration REAL,
        width INTEGER,
        height INTEGER,
        format TEXT
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        candidate_name TEXT,
        video_type TEXT DEFAULT 'training',
        skill_focus TEXT,
        secondary_skills JSONB DEFAULT '[]',
        session_summary TEXT,
        current_level TEXT,
        technical_analysis JSONB DEFAULT '{}',
        improvement_tips JSONB DEFAULT '[]',
        common_mistakes JSONB DEFAULT '[]',
        practice_progression JSONB DEFAULT '[]',
        youtube_recommendations JSONB DEFAULT '[]',
        video_url TEXT,
        public_id TEXT,
        skill TEXT,
        raw JSONB DEFAULT '{}',
        created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      );
    `);

    const addCol = async (table, col, type) => {
      try { await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); }
      catch (e) { /* column may already exist */ }
    };
    await addCol('users', 'name', 'TEXT');
    await addCol('users', 'pass_hash', 'TEXT');
    await addCol('users', 'age', 'INTEGER');
    await addCol('users', 'dob', 'TEXT');
    await addCol('users', 'subscription_status', "TEXT DEFAULT 'free'");
    await addCol('users', 'stripe_customer_id', 'TEXT');

    // Migrate password_hash -> pass_hash if old schema exists
    try {
      const colCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'password_hash'
      `);
      if (colCheck.rows.length > 0) {
        await client.query(`UPDATE users SET pass_hash = password_hash WHERE pass_hash IS NULL AND password_hash IS NOT NULL`);
        console.log('[BK] Migrated password_hash -> pass_hash');
      }
    } catch (e) { console.error('[BK] password_hash migration skipped:', e.message); }
    console.log('[BK] PostgreSQL tables initialized');
  } catch (e) {
    console.error('[BK] Failed to initialize DB tables:', e.message);
  } finally {
    client.release();
  }
}

/* ---------- DB helper functions ---------- */
async function findUser(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [String(email)]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createUser({ id, name, email, passHash, age, dob }) {
  await pool.query(
    `INSERT INTO users (id, name, email, pass_hash, age, dob, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, name, email, passHash, age, dob, Date.now()]
  );
}

async function updateUser(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function getProfile(userId) {
  const { rows } = await pool.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
  if (!rows[0]) return {};
  const r = rows[0];
  return { name: r.name, age: r.age, dob: r.dob, height: r.height, weight: r.weight, foot: r.foot, position: r.position, skill: r.skill, updatedAt: r.updated_at };
}

async function upsertProfile(userId, body) {
  const existing = await getProfile(userId);
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

  const profile = {
    name: body.name ?? existing.name ?? null,
    age: body.age ?? existing.age ?? null,
    dob: body.dob ?? existing.dob ?? null,
    height: heightInches,
    weight: body.weight ?? existing.weight ?? null,
    foot: body.foot ?? existing.foot ?? null,
    position: body.position ?? existing.position ?? null,
    skill: body.skill ?? existing.skill ?? null,
    updated_at: Date.now(),
  };

  await pool.query(
    `INSERT INTO profiles (user_id, name, age, dob, height, weight, foot, position, skill, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE SET
       name = $2, age = $3, dob = $4, height = $5, weight = $6,
       foot = $7, position = $8, skill = $9, updated_at = $10`,
    [userId, profile.name, profile.age, profile.dob, profile.height, profile.weight, profile.foot, profile.position, profile.skill, profile.updated_at]
  );
  return profile;
}

async function getAnalysesByUser(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM analyses WHERE user_id = $1 ORDER BY created_at DESC', [userId]
  );
  return rows.map(r => ({
    id: r.id, candidateName: r.candidate_name, videoType: r.video_type,
    skillFocus: r.skill_focus, secondarySkills: r.secondary_skills,
    sessionSummary: r.session_summary, currentLevel: r.current_level,
    technicalAnalysis: r.technical_analysis, improvementTips: r.improvement_tips,
    commonMistakesForPosition: r.common_mistakes, practiceProgression: r.practice_progression,
    youtubeRecommendations: r.youtube_recommendations,
    video_url: r.video_url, public_id: r.public_id, skill: r.skill,
    raw: r.raw, created_at: Number(r.created_at),
  }));
}

async function getAnalysisById(userId, analysisId) {
  const { rows } = await pool.query(
    'SELECT * FROM analyses WHERE id = $1 AND user_id = $2', [analysisId, userId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, candidateName: r.candidate_name, videoType: r.video_type,
    skillFocus: r.skill_focus, secondarySkills: r.secondary_skills,
    sessionSummary: r.session_summary, currentLevel: r.current_level,
    technicalAnalysis: r.technical_analysis, improvementTips: r.improvement_tips,
    commonMistakesForPosition: r.common_mistakes, practiceProgression: r.practice_progression,
    youtubeRecommendations: r.youtube_recommendations,
    video_url: r.video_url, public_id: r.public_id, skill: r.skill,
    raw: r.raw, created_at: Number(r.created_at),
  };
}

async function insertAnalysis(userId, item) {
  await pool.query(
    `INSERT INTO analyses (id, user_id, candidate_name, video_type, skill_focus, secondary_skills,
       session_summary, current_level, technical_analysis, improvement_tips, common_mistakes,
       practice_progression, youtube_recommendations, video_url, public_id, skill, raw, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [item.id, userId, item.candidateName, item.videoType, item.skillFocus,
     JSON.stringify(item.secondarySkills), item.sessionSummary, item.currentLevel,
     JSON.stringify(item.technicalAnalysis), JSON.stringify(item.improvementTips),
     JSON.stringify(item.commonMistakesForPosition), JSON.stringify(item.practiceProgression),
     JSON.stringify(item.youtubeRecommendations), item.video_url, item.public_id,
     item.skill, JSON.stringify(item.raw), item.created_at]
  );
}

async function deleteAnalysis(userId, analysisId) {
  const { rowCount } = await pool.query(
    'DELETE FROM analyses WHERE id = $1 AND user_id = $2', [analysisId, userId]
  );
  return rowCount > 0;
}

async function getAnalysisCount(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as count FROM analyses WHERE user_id = $1', [userId]
  );
  return parseInt(rows[0].count, 10);
}

async function insertClip(userId, clip) {
  await pool.query(
    `INSERT INTO clips (user_id, url, public_id, created_at, bytes, duration, width, height, format)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, clip.url, clip.public_id, clip.created_at, clip.bytes, clip.duration, clip.width, clip.height, clip.format]
  );
}

async function getClipCount(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as count FROM clips WHERE user_id = $1', [userId]
  );
  return parseInt(rows[0].count, 10);
}

/* ---------- Token Blacklist ---------- */
const tokenBlacklist = new Set();

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

async function sendWelcomeEmail(userName, userEmail) {
  if (!resend) {
    console.log('[BK] Resend not configured, skipping welcome email');
    return;
  }
  try {
    await resend.emails.send({
      from: 'Ball Knowledge <onboarding@resend.dev>',
      to: userEmail,
      subject: 'Welcome to Ball Knowledge!',
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#ffffff;border-radius:16px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#00ff95,#19d3ff);padding:40px 32px;text-align:center">
            <h1 style="margin:0;font-size:28px;color:#0a0a0a">⚽ Ball Knowledge</h1>
            <p style="margin:8px 0 0;color:#0a0a0a;font-size:16px;opacity:0.8">Personal Soccer Training Analysis</p>
          </div>
          <div style="padding:32px">
            <h2 style="margin:0 0 16px;color:#00ff95;font-size:22px">Welcome, ${userName}!</h2>
            <p style="color:#cccccc;font-size:16px;line-height:1.7;margin:0 0 24px">
              Thank you for joining Ball Knowledge. You're all set to start analyzing your soccer training with AI-powered coaching feedback.
            </p>
            <p style="color:#cccccc;font-size:16px;line-height:1.7;margin:0 0 24px">
              Upload a training video and our Gemini AI will watch the full clip, break down your technique, and give you personalized tips to improve your game.
            </p>
            <div style="text-align:center;margin:32px 0">
              <a href="https://ai-soccer-backend-2-production.up.railway.app" style="background:linear-gradient(135deg,#00ff95,#19d3ff);color:#0a0a0a;text-decoration:none;padding:14px 40px;border-radius:12px;font-weight:700;font-size:16px;display:inline-block">
                Start Analyzing
              </a>
            </div>
            <p style="color:#666666;font-size:13px;text-align:center;margin:24px 0 0;border-top:1px solid #222;padding-top:20px">
              Analyze. Improve. Dominate.
            </p>
          </div>
        </div>
      `,
    });
    console.log(`[BK] Welcome email sent to ${userEmail}`);
  } catch (err) {
    console.error('[BK] Failed to send welcome email:', err.message);
  }
}

app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, age, dob } = req.body || {};
    if (!name || !email || !password || !age || !dob) {
      return res.status(400).json({ ok: false, error: 'All fields required' });
    }
    const existing = await findUser(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'Email already registered' });
    }

    const id = uuidv4();
    const passHash = await bcrypt.hash(String(password), 10);
    const trimName = String(name).trim();
    const trimEmail = String(email).trim().toLowerCase();

    await createUser({ id, name: trimName, email: trimEmail, passHash, age: Number(age), dob: String(dob).trim() });

    sendWelcomeEmail(trimName, trimEmail);

    const token = jwt.sign(
      { sub: id, email: trimEmail, name: trimName },
      JWT_SECRET,
      { expiresIn: '30d' },
    );

    res.json({
      ok: true,
      token,
      user: { id, name: trimName, email: trimEmail },
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

    const user = await findUser(email);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const hash = user.pass_hash || user.password_hash;
    if (!hash) return res.status(401).json({ ok: false, error: 'Account needs password reset' });
    const ok = await bcrypt.compare(String(password), hash);
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

/* ---------- Password Reset ---------- */
const pendingResets = new Map(); // email -> { code, expiresAt }

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Email required' });

    const user = await findUser(email);
    if (!user) return res.json({ ok: true, message: 'If that email is registered, a reset code has been sent.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    pendingResets.set(user.email, { code, expiresAt: Date.now() + 15 * 60 * 1000 });

    if (resend) {
      await resend.emails.send({
        from: 'Ball Knowledge <onboarding@resend.dev>',
        to: user.email,
        subject: 'Your Ball Knowledge Password Reset Code',
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#ffffff;border-radius:16px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#00ff95,#19d3ff);padding:32px;text-align:center">
              <h1 style="margin:0;font-size:24px;color:#0a0a0a">⚽ Ball Knowledge</h1>
            </div>
            <div style="padding:32px;text-align:center">
              <h2 style="margin:0 0 12px;color:#ffffff">Password Reset</h2>
              <p style="color:#cccccc;font-size:15px;line-height:1.6">Use this code to reset your password. It expires in 15 minutes.</p>
              <div style="background:#141B2D;border:2px solid #00ff95;border-radius:12px;padding:20px;margin:24px 0;font-size:36px;font-weight:800;letter-spacing:8px;color:#00ff95">${code}</div>
              <p style="color:#666;font-size:13px">If you didn't request this, you can ignore this email.</p>
            </div>
          </div>
        `,
      });
      console.log(`[BK] Password reset code sent to ${user.email}`);
    }

    res.json({ ok: true, message: 'If that email is registered, a reset code has been sent.' });
  } catch (e) {
    console.error('[BK] forgot-password error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      return res.status(400).json({ ok: false, error: 'Email, code, and new password required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    }

    const user = await findUser(email);
    if (!user) return res.status(400).json({ ok: false, error: 'Invalid email or code' });

    const reset = pendingResets.get(user.email);
    if (!reset || reset.code !== code) {
      return res.status(400).json({ ok: false, error: 'Invalid or expired code' });
    }
    if (Date.now() > reset.expiresAt) {
      pendingResets.delete(user.email);
      return res.status(400).json({ ok: false, error: 'Code has expired. Request a new one.' });
    }

    const newHash = await bcrypt.hash(String(newPassword), 10);
    await pool.query('UPDATE users SET pass_hash = $1 WHERE id = $2', [newHash, user.id]);
    pendingResets.delete(user.email);

    console.log(`[BK] Password reset for ${user.email}`);
    res.json({ ok: true, message: 'Password reset successfully. You can now log in.' });
  } catch (e) {
    console.error('[BK] reset-password error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const u = await findUserById(req.userId);
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

app.get('/api/profile', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  const profile = await getProfile(req.userId);
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, age: user.age, dob: user.dob }, profile });
});

app.post('/api/profile', auth, async (req, res) => {
  const { name, age, dob, position, foot, height, weight } = req.body || {};
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  const updates = {};
  if (name) updates.name = name;
  if (age) updates.age = Number(age);
  if (dob) updates.dob = dob;
  if (Object.keys(updates).length) await updateUser(req.userId, updates);
  await upsertProfile(req.userId, { position: position || null, foot: foot || null, height: Number(height) || null, weight: Number(weight) || null });
  const updatedUser = await findUserById(req.userId);
  const profile = await getProfile(req.userId);
  res.json({ ok: true, user: { id: updatedUser.id, name: updatedUser.name, email: updatedUser.email, age: updatedUser.age, dob: updatedUser.dob }, profile });
});

app.put('/api/profile', auth, async (req, res) => {
  await upsertProfile(req.userId, req.body || {});
  const user = await findUserById(req.userId);
  const profile = await getProfile(req.userId);
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, age: user.age, dob: user.dob }, profile });
});

/* ==================================================================== */
/*                                CLIPS                                  */
/* ==================================================================== */

app.post('/api/clip', auth, async (req, res) => {
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  if (!url && !public_id) {
    return res.status(400).json({ ok: false, error: 'url or public_id required' });
  }
  const clip = {
    url: url || null, public_id: public_id || null,
    created_at: created_at || new Date().toISOString(),
    bytes: Number(bytes) || null, duration: Number(duration) || null,
    width: Number(width) || null, height: Number(height) || null, format: format || null,
  };
  await insertClip(req.userId, clip);
  const total = await getClipCount(req.userId);
  res.json({ ok: true, clip, total });
});

/* ==================================================================== */
/*                               LIBRARY                                 */
/* ==================================================================== */

app.get('/api/analyses', auth, async (req, res) => {
  const items = await getAnalysesByUser(req.userId);
  const profile = await getProfile(req.userId);
  const user = await findUserById(req.userId);
  const mapped = items.map(item => ({
    id: item.id,
    candidateName: item.candidateName || profile.name || user?.name || "Player",
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
  res.json({ ok: true, items: mapped, analyses: mapped });
});

app.get('/api/analyses/:id', auth, async (req, res) => {
  const item = await getAnalysisById(req.userId, req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });

  const levelMap = {
    'Beginner': { grade: '4-5', description: 'Beginner' },
    'Intermediate': { grade: '6-7', description: 'Intermediate' },
    'Advanced': { grade: '8-9', description: 'Advanced' }
  };
  const currentLevelObj = levelMap[item.currentLevel] || { grade: '?', description: item.currentLevel };
  const profile = await getProfile(req.userId);
  const user = await findUserById(req.userId);

  res.json({
    ok: true,
    id: item.id,
    candidateName: item.candidateName || profile.name || user?.name || "Player",
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

app.delete('/api/analyses/:id', auth, async (req, res) => {
  const deleted = await deleteAnalysis(req.userId, req.params.id);
  if (!deleted) return res.status(404).json({ ok: false, error: 'Not found' });
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

  console.log(`[BK] Uploading video for Gemini analysis...`);
  const file = await uploadVideoToGemini(videoUrl, videoData);

  const prompt = `You are an elite-level soccer / football coach and technical analyst with 20+ years of experience coaching all ages from youth academy to professional. You have deep expertise in biomechanics, freestyle football, technical training, and player development. The player's stated position is ${position}.

===== HOW TO WATCH THE VIDEO =====
1. Watch the ENTIRE video from start to finish before forming any conclusions.
2. Pay attention to every single touch, movement, and transition.
3. Note the SPECIFIC skills, tricks, and techniques being performed — NAME THEM by their real names.
4. Track which foot (left/right) is being used for each action when visible.
5. Notice body mechanics: ankle lock, knee position, hip rotation, shoulder alignment, center of gravity.
6. Count approximate touches, note the rhythm, and observe consistency across attempts.

===== ACCURACY RULES (CRITICAL) =====
- Describe ONLY what you can actually see. Do NOT assume, guess, or hallucinate.
- If the player only uses their feet, do NOT say they used thighs or head.
- If the camera angle makes something unclear, say so explicitly.
- Be honest about what was done well AND what needs work. Do not sugarcoat.

===== WHAT TO ANALYZE BY ACTIVITY TYPE =====

JUGGLING / FREESTYLE:
- Name every trick you can identify: Around the World (ATW), crossover, Akka, Touzani Around the World (TATW), Hop the World (HTW), neck stall, sole stall, clipper, rainbow flick, sombrero, Maradona, etc.
- Evaluate touch quality: Is the ball staying close? Are touches soft and controlled or hard and bouncy?
- Note which foot is dominant and whether weak foot is used at all.
- Assess rhythm and flow: Are trick transitions smooth or does the player reset to basic juggling between each trick?
- Count longest juggling streak if visible. Note any drops.

SHOOTING:
- Analyze approach angle and run-up (straight, angled, length of run-up).
- Identify striking technique: laces drive, instep curl, outside foot, chip, knuckleball, toe poke, volley, half-volley.
- Evaluate plant foot placement (next to ball, behind, too far away).
- Check body position at contact: leaning back (ball goes high), over the ball (driven shot), hip rotation, follow-through direction.
- Assess power vs accuracy balance. Note where the shot goes (top corner, low, wide, saved, etc.).
- Identify common shooting mistakes: leaning too far back, planting foot too far from ball, looking down at contact, no follow-through, ankle not locked.

DRIBBLING:
- Identify specific moves: stepovers, scissors, Cruyff turn, La Croqueta, elastico, ball roll, chop, drag-back, Ronaldo chop, Maradona spin, body feint, nutmeg attempt, etc.
- Evaluate first touch quality: Is it too heavy? Does the ball get away? Is it controlled into space?
- Note close control vs speed: Is the ball glued to their feet? How many touches per distance?
- Assess change of pace and direction. Is there an explosive burst after the move?
- Check head position: Are they looking up (scanning) or always staring at the ball?
- Note bad touches specifically: which foot, what happened, did they lose the ball?

PASSING:
- Identify pass types: short pass, through ball, long ball, lofted pass, driven pass, outside-foot pass, backheel, cross, switch of play.
- Evaluate weight of pass (too hard, too soft, just right).
- Check technique: inside foot, laces, outside foot, which foot.
- Assess accuracy and intention vs result.

BALL CONTROL / FIRST TOUCH:
- Note receiving technique: inside foot, sole, outside foot, thigh, chest.
- Is the first touch setting them up for the next action or killing their momentum?
- Evaluate control under different scenarios (ground ball, aerial ball, etc.).

===== SKILL LEVEL ASSESSMENT =====
- "Beginner": Struggling with basic ball control. Frequent loss of possession. Simple touches only. Inconsistent striking. Cannot perform basic tricks.
- "Intermediate": Solid fundamentals. Can juggle consistently (20+ touches). Performs basic tricks (ATW, sole stalls). Decent shooting technique with room for improvement. Comfortable dribbling at moderate pace. Some weak foot ability.
- "Advanced": Executes complex freestyle tricks cleanly and consistently. Strong both feet. Powerful and accurate shooting with proper technique. Close dribbling control at speed. Smooth transitions between skills. High touch count juggling with trick combos.
- A player performing freestyle tricks (ATW, crossovers, Akkas, etc.) is AT LEAST Intermediate. If done fluidly with combos, they are Advanced.

===== COACHING FEEDBACK RULES =====
- For every weakness you identify, provide a SPECIFIC drill or exercise to fix it. Not generic advice — real drills a coach would assign.
- Reference real coaching terminology and biomechanics.
- Improvement tips should be prioritized: fix the biggest technical issue first.
- YouTube recommendations should be REAL channels known for soccer coaching/training (e.g., Unisport, Progressive Soccer, 7MLC, Joner 1on1, Tom Byer, Tekkerz Kid, etc.) with specific video topics that address the player's weaknesses.

Respond with ONLY valid JSON (no markdown fences, no backticks). Use this exact schema:
{
  "sessionSummary": "2-3 detailed paragraphs describing exactly what you saw in the video — the specific skills performed, the quality of execution, standout moments (good and bad), and overall assessment. Be vivid and specific as if you watched every second.",
  "skillFocus": "Primary skill being trained (e.g., Freestyle Juggling, Shooting Technique, Close Dribbling, Passing Accuracy)",
  "secondarySkills": ["skill 1", "skill 2"],
  "currentLevel": "Beginner | Intermediate | Advanced",
  "technicalAnalysis": {
    "footwork": "Detailed analysis of foot technique — which foot is used, ankle lock, touch quality, surface of foot",
    "bodyPosition": "Posture, balance, center of gravity, knee bend, hip alignment during the skill",
    "followThrough": "Completion of movement — follow-through on shots, fluidity of trick execution, finishing touches",
    "consistency": "How repeatable is the technique? Success rate, drop frequency, accuracy across attempts",
    "sessionProgression": "Did the player improve during the video? Did they attempt harder variations? Did fatigue affect quality?"
  },
  "improvementTips": [{"priority": 1, "tip": "specific technique fix", "why": "biomechanical or tactical reason", "how": "exact drill or exercise with reps/sets/setup"}],
  "commonMistakesForPosition": [{"mistake": "specific technical error", "observed": true, "correction": "exactly how to fix it with a drill"}],
  "practiceProgression": [{"level": "current", "drill": "drill they should do now"}, {"level": "next", "drill": "drill to progress to once current is mastered"}],
  "youtubeRecommendations": [{"title": "specific video topic", "coach": "real YouTube channel name", "why": "how it addresses this player's specific needs"}]
}`;

  console.log('[BK] Sending video to Gemini 2.0 Flash...');
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const contentParts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ];

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

/* ==================================================================== */
/*                          SUBSCRIPTION / PAYWALL                      */
/* ==================================================================== */

app.get('/api/subscription-status', auth, async (req, res) => {
  const currentUser = await findUserById(req.userId);
  const analysisCount = await getAnalysisCount(req.userId);
  const subStatus = currentUser?.subscription_status || 'free';
  const isAdmin = ADMIN_EMAILS.includes(currentUser?.email?.toLowerCase());
  const canAnalyze = isAdmin || analysisCount < FREE_ANALYSIS_LIMIT || subStatus === 'active';

  res.json({
    ok: true,
    plan: isAdmin ? 'admin' : (subStatus === 'active' ? 'pro' : 'free'),
    analysisCount,
    limit: FREE_ANALYSIS_LIMIT,
    remaining: (isAdmin || subStatus === 'active') ? 'unlimited' : Math.max(0, FREE_ANALYSIS_LIMIT - analysisCount),
    canAnalyze,
  });
});

app.post('/api/create-checkout-session', auth, async (req, res) => {
  if (!stripe) {
    return res.status(400).json({ ok: false, error: 'Stripe not configured' });
  }
  try {
    const currentUser = await findUserById(req.userId);
    const appUrl = `${req.protocol}://${req.get('host')}`;

    const prices = await stripe.prices.list({ lookup_keys: [STRIPE_LOOKUP_KEY], limit: 1 });
    if (!prices.data.length) {
      return res.status(400).json({ ok: false, error: 'Price not found in Stripe' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: prices.data[0].id, quantity: 1 }],
      metadata: { userId: req.userId },
      customer_email: currentUser?.email,
      success_url: `${appUrl}?session_id={CHECKOUT_SESSION_ID}&upgrade=success#/analyze`,
      cancel_url: `${appUrl}?upgrade=cancelled#/analyze`,
    });

    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('[BK] Stripe checkout error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to create checkout session' });
  }
});

app.post('/api/manage-subscription', auth, async (req, res) => {
  if (!stripe) {
    return res.status(400).json({ ok: false, error: 'Stripe not configured' });
  }
  try {
    const currentUser = await findUserById(req.userId);
    if (!currentUser?.stripe_customer_id) {
      return res.status(400).json({ ok: false, error: 'No active subscription' });
    }
    const appUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: currentUser.stripe_customer_id,
      return_url: `${appUrl}#/account`,
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('[BK] Stripe portal error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to open billing portal' });
  }
});

/* ==================================================================== */
/*                     TRAINING ANALYSIS                                */
/* ==================================================================== */

app.post('/api/analyze', auth, async (req, res) => {
  try {
    const currentUser = await findUserById(req.userId);
    const analysisCount = await getAnalysisCount(req.userId);
    const subStatus = currentUser?.subscription_status || 'free';
    const isAdmin = ADMIN_EMAILS.includes(currentUser?.email?.toLowerCase());

    if (!isAdmin && analysisCount >= FREE_ANALYSIS_LIMIT && subStatus !== 'active') {
      return res.status(403).json({
        ok: false,
        error: 'limit_reached',
        analysisCount,
        limit: FREE_ANALYSIS_LIMIT,
        message: `You've used your ${FREE_ANALYSIS_LIMIT} free analyses. Upgrade to Ball Knowledge Pro for unlimited analysis.`
      });
    }

    const {
      height, heightFeet, heightInches,
      weight, foot, position,
      videoUrl, publicId,
      videoData,
      skill,
    } = req.body || {};

    console.log(`[BK] Analyze request - videoUrl: ${videoUrl ? 'present' : 'none'}, videoData: ${videoData ? 'present' : 'none'}, skill: ${skill}`);

    if (!videoUrl && !videoData) {
      return res.status(400).json({ ok: false, error: 'Upload a training clip before analyzing.' });
    }

    await upsertProfile(req.userId, { height, heightFeet, heightInches, weight, foot, position, skill });

    const profile = await getProfile(req.userId);
    const user = currentUser || {};

    const result = await runTextAnalysisForTraining({
      profile,
      user,
      videoUrl,
      videoData,
      skill: skill || profile.skill || null,
    });

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
      skill: skill || profile.skill || null,
      raw: result.raw,
      created_at: Date.now(),
    };

    await insertAnalysis(req.userId, item);

    console.log(`[BK] Analysis complete for user ${req.userId} - Skill: ${item.skillFocus}, Level: ${item.currentLevel}`);

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
      return res.status(400).json({ ok: false, error: "Missing playerContext or clipsNotes" });
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
    res.status(500).json({ ok: false, error: e.message });
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
async function start() {
  try {
    await initDB();
  } catch (e) {
    console.error('[BK] CRITICAL: Could not initialise database:', e.message);
    console.error('[BK] Server will start but DB operations will fail.');
  }
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[BK] Server running on http://localhost:${PORT}`);
    console.log(`[BK] PostgreSQL: connected`);
    console.log(`[BK] Gemini AI configured: ${genAI ? 'YES' : 'NO'}`);
    console.log(`[BK] Stripe configured: ${stripe ? 'YES' : 'NO'} (key starts with: ${STRIPE_SECRET ? STRIPE_SECRET.substring(0, 7) + '...' : 'EMPTY'})`);
    console.log(`[BK] Resend configured: ${resend ? 'YES' : 'NO'}`);
    console.log(`[BK] Admin emails: ${ADMIN_EMAILS.length ? ADMIN_EMAILS.join(', ') : 'none'}`);
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
}

start();
