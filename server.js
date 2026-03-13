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
const STRIPE_LOOKUP_KEY = process.env.STRIPE_PRICE_LOOKUP_KEY || 'Training_Video_Analysis_-293c440';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
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
    const tables = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        pass_hash TEXT,
        age INTEGER,
        dob TEXT,
        subscription_status TEXT DEFAULT 'free',
        stripe_customer_id TEXT,
        created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      )`,
      `CREATE TABLE IF NOT EXISTS profiles (
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
      )`,
      `CREATE TABLE IF NOT EXISTS clips (
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
      )`,
      `CREATE TABLE IF NOT EXISTS analyses (
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
      )`,
      `CREATE TABLE IF NOT EXISTS player_stats (
        user_id TEXT PRIMARY KEY,
        total_analyses INTEGER DEFAULT 0,
        skill_frequency JSONB DEFAULT '{}',
        skill_levels JSONB DEFAULT '{}',
        skill_last_seen JSONB DEFAULT '{}',
        monthly_activity JSONB DEFAULT '{}',
        last_analysis_at BIGINT,
        updated_at BIGINT
      )`,
      `CREATE TABLE IF NOT EXISTS skill_reminders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        skill TEXT NOT NULL,
        drill TEXT,
        note TEXT,
        remind_at BIGINT NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        updated_at BIGINT
      )`,
    ];

    for (const sql of tables) {
      try { await client.query(sql); }
      catch (e) { console.error(`[BK] Table creation note: ${e.message}`); }
    }

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
    await addCol('analyses', 'candidate_name', 'TEXT');
    await addCol('analyses', 'video_type', "TEXT DEFAULT 'training'");
    await addCol('analyses', 'skill_focus', 'TEXT');
    await addCol('analyses', 'secondary_skills', "JSONB DEFAULT '[]'");
    await addCol('analyses', 'session_summary', 'TEXT');
    await addCol('analyses', 'current_level', 'TEXT');
    await addCol('analyses', 'technical_analysis', "JSONB DEFAULT '{}'");
    await addCol('analyses', 'improvement_tips', "JSONB DEFAULT '[]'");
    await addCol('analyses', 'common_mistakes', "JSONB DEFAULT '[]'");
    await addCol('analyses', 'practice_progression', "JSONB DEFAULT '[]'");
    await addCol('analyses', 'youtube_recommendations', "JSONB DEFAULT '[]'");
    await addCol('analyses', 'video_url', 'TEXT');
    await addCol('analyses', 'public_id', 'TEXT');
    await addCol('analyses', 'skill', 'TEXT');
    await addCol('analyses', 'raw', "JSONB DEFAULT '{}'");
    await addCol('player_stats', 'monthly_activity', "JSONB DEFAULT '{}'");
    await addCol('skill_reminders', 'drill', 'TEXT');
    await addCol('skill_reminders', 'note', 'TEXT');
    await addCol('skill_reminders', 'completed', "BOOLEAN DEFAULT FALSE");
    await addCol('skill_reminders', 'updated_at', 'BIGINT');

    // Drop NOT NULL constraints on legacy columns that our code doesn't populate
    const dropNotNull = async (table, col) => {
      try { await client.query(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`); }
      catch (e) { /* column may not exist or already nullable */ }
    };
    await dropNotNull('analyses', 'analysis_data');
    await dropNotNull('analyses', 'video_url');
    await dropNotNull('analyses', 'user_id');
    await dropNotNull('users', 'name');
    await dropNotNull('users', 'pass_hash');
    await dropNotNull('users', 'password_hash');

    // Set defaults on legacy columns so inserts don't fail
    try { await client.query(`ALTER TABLE analyses ALTER COLUMN analysis_data SET DEFAULT '{}'::jsonb`); } catch {}
    try { await client.query(`ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT ''`); } catch {}
    try { await client.query(`ALTER TABLE analyses ALTER COLUMN video_type DROP NOT NULL`); } catch {}
    try { await client.query(`ALTER TABLE analyses ALTER COLUMN video_type SET DEFAULT 'training'`); } catch {}

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
    `INSERT INTO users (id, name, email, pass_hash, password_hash, age, dob, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, name, email, passHash, passHash, age, dob, Date.now()]
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
    raw: r.raw, created_at: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at) || Date.now(),
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
    raw: r.raw, created_at: r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at) || Date.now(),
  };
}

async function insertAnalysis(userId, item) {
  const createdAtMs = item.created_at || Date.now();
  const doInsert = () => pool.query(
    `INSERT INTO analyses (id, user_id, candidate_name, video_type, skill_focus, secondary_skills,
       session_summary, current_level, technical_analysis, improvement_tips, common_mistakes,
       practice_progression, youtube_recommendations, video_url, public_id, skill, raw, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [item.id, userId, item.candidateName, item.videoType || 'training', item.skillFocus,
     JSON.stringify(item.secondarySkills || []), item.sessionSummary, item.currentLevel,
     JSON.stringify(item.technicalAnalysis || {}), JSON.stringify(item.improvementTips || []),
     JSON.stringify(item.commonMistakesForPosition || []), JSON.stringify(item.practiceProgression || []),
     JSON.stringify(item.youtubeRecommendations || []), item.video_url || null, item.public_id || null,
     item.skill || null, JSON.stringify(item.raw || {}), createdAtMs]
  );

  try {
    await doInsert();
    updatePlayerStats(userId, item).catch(e =>
      console.error('[BK] updatePlayerStats failed:', e.message)
    );
  } catch (e) {
    console.error('[BK] insertAnalysis first attempt failed:', e.message);
    if (e.message.includes('does not exist') || e.message.includes('undefined column') || e.message.includes('not-null constraint') || e.message.includes('violates not')) {
      console.log('[BK] Attempting to create/fix analyses table and retry...');
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS analyses (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, candidate_name TEXT,
          video_type TEXT DEFAULT 'training', skill_focus TEXT,
          secondary_skills JSONB DEFAULT '[]', session_summary TEXT, current_level TEXT,
          technical_analysis JSONB DEFAULT '{}', improvement_tips JSONB DEFAULT '[]',
          common_mistakes JSONB DEFAULT '[]', practice_progression JSONB DEFAULT '[]',
          youtube_recommendations JSONB DEFAULT '[]', video_url TEXT, public_id TEXT,
          skill TEXT, raw JSONB DEFAULT '{}',
          created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )`);
        const addCol = async (col, type) => {
          try { await pool.query(`ALTER TABLE analyses ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch {}
        };
        await addCol('candidate_name', 'TEXT'); await addCol('video_type', "TEXT DEFAULT 'training'");
        await addCol('skill_focus', 'TEXT'); await addCol('secondary_skills', "JSONB DEFAULT '[]'");
        await addCol('session_summary', 'TEXT'); await addCol('current_level', 'TEXT');
        await addCol('technical_analysis', "JSONB DEFAULT '{}'"); await addCol('improvement_tips', "JSONB DEFAULT '[]'");
        await addCol('common_mistakes', "JSONB DEFAULT '[]'"); await addCol('practice_progression', "JSONB DEFAULT '[]'");
        await addCol('youtube_recommendations', "JSONB DEFAULT '[]'"); await addCol('video_url', 'TEXT');
        await addCol('public_id', 'TEXT'); await addCol('skill', 'TEXT'); await addCol('raw', "JSONB DEFAULT '{}'");
        // Fix legacy NOT NULL constraints
        try { await pool.query(`ALTER TABLE analyses ALTER COLUMN analysis_data DROP NOT NULL`); } catch {}
        try { await pool.query(`ALTER TABLE analyses ALTER COLUMN analysis_data SET DEFAULT '{}'::jsonb`); } catch {}
        await doInsert();
        updatePlayerStats(userId, item).catch(e =>
          console.error('[BK] updatePlayerStats failed:', e.message)
        );
        console.log('[BK] Retry succeeded after table fix');
      } catch (retryErr) {
        console.error('[BK] insertAnalysis retry also failed:', retryErr.message);
        throw retryErr;
      }
    } else {
      throw e;
    }
  }
}

async function updatePlayerStats(userId, item) {
  try {
    const now = Date.now();
    const ts = item.created_at || now;
    const d = new Date(ts);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    const primarySkill = item.skillFocus || null;
    const secondary = Array.isArray(item.secondarySkills) ? item.secondarySkills.filter(Boolean) : [];
    const allSkills = primarySkill ? [primarySkill, ...secondary] : secondary;
    const level = item.currentLevel || null;

    const { rows } = await pool.query('SELECT * FROM player_stats WHERE user_id = $1', [userId]);
    const existing = rows[0] || null;

    const skillFreq     = existing?.skill_frequency   || {};
    const skillLevels   = existing?.skill_levels      || {};
    const skillLastSeen = existing?.skill_last_seen   || {};
    const monthlyAct    = existing?.monthly_activity  || {};

    for (const sk of allSkills) {
      if (!sk) continue;
      skillFreq[sk] = (skillFreq[sk] || 0) + 1;
    }
    if (primarySkill && level) skillLevels[primarySkill] = level;
    if (primarySkill) skillLastSeen[primarySkill] = ts;

    if (!monthlyAct[monthKey]) monthlyAct[monthKey] = { sessions: 0, skills: [] };
    monthlyAct[monthKey].sessions += 1;
    if (primarySkill && !monthlyAct[monthKey].skills.includes(primarySkill)) {
      monthlyAct[monthKey].skills.push(primarySkill);
    }

    const totalAnalyses = (existing?.total_analyses || 0) + 1;

    await pool.query(
      `INSERT INTO player_stats
         (user_id, total_analyses, skill_frequency, skill_levels, skill_last_seen,
          monthly_activity, last_analysis_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         total_analyses   = $2,
         skill_frequency  = $3::jsonb,
         skill_levels     = $4::jsonb,
         skill_last_seen  = $5::jsonb,
         monthly_activity = $6::jsonb,
         last_analysis_at = $7,
         updated_at       = $8`,
      [userId, totalAnalyses,
       JSON.stringify(skillFreq), JSON.stringify(skillLevels),
       JSON.stringify(skillLastSeen), JSON.stringify(monthlyAct),
       ts, now]
    );
    console.log(`[BK] updatePlayerStats OK for user ${userId} - total: ${totalAnalyses}`);
  } catch (e) {
    console.error('[BK] updatePlayerStats error (non-fatal):', e.message);
  }
}

async function deleteAnalysis(userId, analysisId) {
  const { rowCount } = await pool.query(
    'DELETE FROM analyses WHERE id = $1 AND user_id = $2', [analysisId, userId]
  );
  return rowCount > 0;
}

async function getAnalysisCount(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) as count FROM analyses WHERE user_id = $1', [userId]
    );
    return parseInt(rows[0].count, 10);
  } catch (e) {
    console.error('[BK] getAnalysisCount error (table may not exist yet):', e.message);
    return 0;
  }
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

function toMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const asNum = Number(value);
  if (!Number.isNaN(asNum) && asNum > 0) {
    // Handle both seconds and milliseconds epoch inputs.
    return asNum > 1e12 ? asNum : asNum * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
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
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

function getGeminiErrorText(err) {
  return String(err?.message || err?.error || err || '');
}

function isGeminiRetryable(err) {
  const text = getGeminiErrorText(err).toLowerCase();
  return err?.status === 429 || err?.status === 503 ||
    text.includes('429') ||
    text.includes('resource exhausted') ||
    text.includes('quota') ||
    text.includes('temporarily unavailable') ||
    text.includes('deadline exceeded') ||
    text.includes('503');
}

async function generateGeminiContent(contentParts, label = 'request') {
  let lastErr = null;
  for (const modelName of GEMINI_MODELS) {
    const model = genAI.getGenerativeModel({ model: modelName });
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(contentParts);
        return { result, modelName };
      } catch (err) {
        lastErr = err;
        const retryable = isGeminiRetryable(err);
        if (!retryable || attempt === maxRetries) break;
        const waitMs = Math.min(30000, 4000 * attempt);
        console.log(`[BK] Gemini ${label} retry (${modelName}) ${attempt}/${maxRetries} in ${Math.round(waitMs / 1000)}s: ${getGeminiErrorText(err)}`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    console.log(`[BK] Gemini model fallback: ${modelName} failed, trying next model...`);
  }
  throw lastErr || new Error('Gemini request failed');
}

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

async function buildHealthPayload() {
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1');
    return {
      ok: true,
      service: 'ball-knowledge-api',
      uptimeSec: Number(process.uptime().toFixed(1)),
      db: 'up',
      geminiConfigured: !!genAI,
      stripeConfigured: !!STRIPE_SECRET,
      resendConfigured: !!RESEND_KEY,
      checkedInMs: Date.now() - startedAt,
      now: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      service: 'ball-knowledge-api',
      uptimeSec: Number(process.uptime().toFixed(1)),
      db: 'down',
      error: e.message || 'DB health check failed',
      checkedInMs: Date.now() - startedAt,
      now: new Date().toISOString(),
    };
  }
}

app.get('/healthz', async (_req, res) => {
  const health = await buildHealthPayload();
  return res.status(health.ok ? 200 : 503).json(health);
});

app.get('/readyz', async (_req, res) => {
  const health = await buildHealthPayload();
  return res.status(health.ok ? 200 : 503).json(health);
});

app.get('/api/health', async (_req, res) => {
  const health = await buildHealthPayload();
  return res.status(health.ok ? 200 : 503).json(health);
});

app.get('/api/test', (_req, res) =>
  res.json({ ok: true, message: 'Test route working!', timestamp: new Date().toISOString() }),
);

app.post('/api/test-ai', async (req, res) => {
  try {
    if (!genAI) {
      return res.status(400).json({ ok: false, error: 'Gemini API key not configured' });
    }
    const { result, modelName } = await generateGeminiContent('Give me one quick soccer training tip in 2 sentences.', 'test-ai');
    const message = result.response.text();
    res.json({ ok: true, message, model: modelName });
  } catch (error) {
    const msg = getGeminiErrorText(error);
    console.error('[BK] test-ai error:', msg);
    if (isGeminiRetryable(error)) {
      return res.status(503).json({
        ok: false,
        error: 'Gemini quota/rate limit reached. Please retry in a minute or verify billing is enabled on your Google AI project.',
        detail: msg,
      });
    }
    res.status(500).json({ ok: false, error: msg });
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
    sessionSnapshot: item.raw?.sessionSnapshot || {},
    technicalAnalysis: item.technicalAnalysis,
    improvementTips: item.improvementTips,
    trendVsLastSessions: item.raw?.trendVsLastSessions || [],
    nextSessionPlan: item.raw?.nextSessionPlan || [],
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
    sessionSnapshot: item.raw?.sessionSnapshot || {},
    technicalAnalysis: item.technicalAnalysis,
    improvementTips: item.improvementTips,
    commonMistakesForPosition: item.commonMistakesForPosition,
    practiceProgression: item.practiceProgression,
    trendVsLastSessions: item.raw?.trendVsLastSessions || [],
    nextSessionPlan: item.raw?.nextSessionPlan || [],
    youtubeRecommendations: item.youtubeRecommendations,
  });
});

app.delete('/api/analyses/:id', auth, async (req, res) => {
  const deleted = await deleteAnalysis(req.userId, req.params.id);
  if (!deleted) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true });
});

/* ==================================================================== */
/*                              REMINDERS                                */
/* ==================================================================== */

app.post('/api/reminders', auth, async (req, res) => {
  try {
    const { skill, drill, note, remindAt } = req.body || {};
    const trimSkill = String(skill || '').trim();
    const ts = Number(remindAt);
    if (!trimSkill) return res.status(400).json({ ok: false, error: 'Skill is required' });
    if (!Number.isFinite(ts) || ts <= 0) return res.status(400).json({ ok: false, error: 'Valid reminder date/time is required' });

    const id = uuidv4();
    const now = Date.now();
    await pool.query(
      `INSERT INTO skill_reminders (id, user_id, skill, drill, note, remind_at, completed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $7)`,
      [id, req.userId, trimSkill, String(drill || '').trim() || null, String(note || '').trim() || null, ts, now]
    );
    res.json({
      ok: true,
      reminder: {
        id,
        skill: trimSkill,
        drill: String(drill || '').trim() || null,
        note: String(note || '').trim() || null,
        remindAt: ts,
        completed: false,
      },
    });
  } catch (e) {
    console.error('[BK] create reminder error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to create reminder' });
  }
});

app.get('/api/reminders', auth, async (req, res) => {
  try {
    const status = String(req.query.status || 'upcoming').trim().toLowerCase();
    let where = 'WHERE user_id = $1';
    if (status === 'completed') where += ' AND completed = TRUE';
    else if (status === 'upcoming') where += ' AND completed = FALSE';
    const order = status === 'completed' ? 'ORDER BY remind_at DESC' : 'ORDER BY remind_at ASC';

    const { rows } = await pool.query(
      `SELECT id, skill, drill, note, remind_at, completed, created_at
       FROM skill_reminders
       ${where}
       ${order}
       LIMIT 500`,
      [req.userId]
    );
    res.json({
      ok: true,
      reminders: rows.map(r => ({
        id: r.id,
        skill: r.skill,
        drill: r.drill,
        note: r.note,
        remindAt: Number(r.remind_at) || 0,
        completed: !!r.completed,
        createdAt: Number(r.created_at) || 0,
      })),
    });
  } catch (e) {
    console.error('[BK] list reminders error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to load reminders' });
  }
});

app.patch('/api/reminders/:id', auth, async (req, res) => {
  try {
    const reminderId = String(req.params.id || '').trim();
    if (!reminderId) return res.status(400).json({ ok: false, error: 'Reminder ID required' });
    const { completed, remindAt, note, drill, skill } = req.body || {};

    const updates = [];
    const vals = [];
    let i = 1;
    if (typeof completed === 'boolean') {
      updates.push(`completed = $${i++}`);
      vals.push(completed);
    }
    if (remindAt !== undefined) {
      const ts = Number(remindAt);
      if (!Number.isFinite(ts) || ts <= 0) return res.status(400).json({ ok: false, error: 'Invalid remindAt' });
      updates.push(`remind_at = $${i++}`);
      vals.push(ts);
    }
    if (note !== undefined) {
      updates.push(`note = $${i++}`);
      vals.push(String(note || '').trim() || null);
    }
    if (drill !== undefined) {
      updates.push(`drill = $${i++}`);
      vals.push(String(drill || '').trim() || null);
    }
    if (skill !== undefined) {
      const trimSkill = String(skill || '').trim();
      if (!trimSkill) return res.status(400).json({ ok: false, error: 'Skill cannot be empty' });
      updates.push(`skill = $${i++}`);
      vals.push(trimSkill);
    }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'No updates provided' });
    updates.push(`updated_at = $${i++}`);
    vals.push(Date.now());
    vals.push(reminderId, req.userId);

    const { rows } = await pool.query(
      `UPDATE skill_reminders
       SET ${updates.join(', ')}
       WHERE id = $${i++} AND user_id = $${i}
       RETURNING id, skill, drill, note, remind_at, completed, created_at`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Reminder not found' });
    const r = rows[0];
    res.json({
      ok: true,
      reminder: {
        id: r.id,
        skill: r.skill,
        drill: r.drill,
        note: r.note,
        remindAt: Number(r.remind_at) || 0,
        completed: !!r.completed,
        createdAt: Number(r.created_at) || 0,
      },
    });
  } catch (e) {
    console.error('[BK] update reminder error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to update reminder' });
  }
});

app.delete('/api/reminders/:id', auth, async (req, res) => {
  try {
    const reminderId = String(req.params.id || '').trim();
    if (!reminderId) return res.status(400).json({ ok: false, error: 'Reminder ID required' });
    const { rowCount } = await pool.query(
      'DELETE FROM skill_reminders WHERE id = $1 AND user_id = $2',
      [reminderId, req.userId]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Reminder not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[BK] delete reminder error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to delete reminder' });
  }
});

/* ==================================================================== */
/*                     PART 1: TRAINING CLIP ANALYSIS                    */
/* ==================================================================== */

async function runTextAnalysisForTraining({ profile, user, videoUrl, videoData, skill }) {
  if (!genAI || !fileManager) {
    throw new Error('Gemini API key not configured. Please set GEMINI_API_KEY environment variable.');
  }

  const position = profile.position || user?.position || 'player';

  // Calculate player age from dob or stored age
  let playerAge = null;
  const dob = profile.dob || user?.dob;
  if (dob) {
    const birthDate = new Date(dob);
    if (!isNaN(birthDate.getTime())) {
      const today = new Date();
      let age = today.getFullYear() - birthDate.getFullYear();
      const m = today.getMonth() - birthDate.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
      if (age > 0 && age < 100) playerAge = age;
    }
  }
  if (!playerAge) playerAge = profile.age || user?.age || null;

  const ageLabel = playerAge ? `${playerAge} years old` : 'unknown age';
  let ageGroup = 'adult';
  if (playerAge) {
    if (playerAge <= 8) ageGroup = 'young child (8 and under)';
    else if (playerAge <= 12) ageGroup = 'youth (9-12)';
    else if (playerAge <= 15) ageGroup = 'teen (13-15)';
    else if (playerAge <= 18) ageGroup = 'older teen (16-18)';
    else ageGroup = 'adult (19+)';
  }

  console.log(`[BK] Uploading video for Gemini analysis... Player age: ${ageLabel}, age group: ${ageGroup}`);
  const file = await uploadVideoToGemini(videoUrl, videoData);

  const prompt = `You are an elite-level soccer / football coach and technical analyst with 20+ years of experience coaching all ages from youth academy to professional. You have deep expertise in biomechanics, freestyle football, technical training, and player development.

PLAYER INFO:
- Position: ${position}
- Age: ${ageLabel}
- Age group: ${ageGroup}
- Requested training focus from player: ${skill || 'not provided'}

===== PRIMARY SKILL DETECTION (CRITICAL) =====
- Choose "skillFocus" from the MOST REPEATED, MOST CENTRAL action in the clip (what the player is actually drilling over and over).
- Do NOT infer skills that are not clearly present. If there are no clear shot attempts, do NOT label shooting.
- Only include a skill in "secondarySkills" if it is clearly observable multiple times (not a one-off touch).
- If the player provided a requested focus, use it as a tie-breaker ONLY when the video evidence supports it.
- If the player says "first touch + passing" and the clip shows repeated wall passing/receiving with control errors, skillFocus should be "First Touch / Ball Control" or "Passing & First Touch" — not shooting.
- For shooting to be listed, there must be clear repeated shot attempts toward a target/goal with striking mechanics visible.

===== AGE-APPROPRIATE COACHING (CRITICAL) =====
You MUST tailor ALL feedback, drills, language, and expectations to the player's age group. The same mistake requires completely different coaching for a 10-year-old vs a 16-year-old.

YOUNG CHILD (8 and under):
- Use simple, fun, encouraging language. Think "coach talking to a kid at practice."
- Keep drill instructions very simple — short, visual, game-like activities (e.g., "kick the ball at the cone 10 times" not "work on your instep contact angle").
- Focus on FUN first, then basic coordination. Do not overwhelm with technical detail.
- Celebrate effort and improvement, not perfection. If they can kick the ball, that's progress.
- Avoid complex biomechanics explanations. Say "try to land on your toes" not "adjust your center of gravity."
- Recommend age-appropriate YouTube content (fun soccer challenges, basic skills for kids).

YOUTH (9-12):
- Encouraging but start introducing real technique vocabulary (e.g., "plant foot", "follow through", "laces").
- Drills should be simple but purposeful — wall passes, cone dribbling courses, target shooting.
- Keep explanations clear and practical. One focus point at a time, not five corrections.
- Emphasize building good habits now: "If you learn to lock your ankle now, shooting gets way easier later."
- This age is about repetition and building a foundation — not perfection.
- Be positive but honest. "You're getting better at X, now let's work on Y."

TEEN (13-15):
- More technical and direct coaching language. They can handle detailed breakdowns.
- Introduce biomechanics concepts: hip rotation, weight transfer, body angles.
- Drills should be more structured with reps, progressions, and game-realistic scenarios.
- Push them harder. Point out habits that will hold them back if not fixed now.
- Reference professional players as examples (e.g., "Watch how Messi drops his shoulder before the cut").
- Expect more consistency and hold them to a higher standard than younger players.

OLDER TEEN (16-18):
- Coach them like a competitive player. Be direct, specific, and demanding.
- Full biomechanical breakdowns. Talk about ankle lock angles, striking through the ball, deceleration mechanics.
- Drills should simulate match conditions: pressure, speed, one-touch play, transitions.
- Identify weaknesses bluntly — "Your weak foot is a liability. Here's how to fix it."
- Reference professional-level standards. If they want to play at the next level, tell them what it takes.
- Discuss tactical awareness and decision-making, not just technique.

ADULT (19+):
- Professional-level coaching analysis. Assume they understand soccer terminology.
- Deep biomechanical and tactical breakdowns.
- High-performance drills with match-realistic intensity.
- Focus on marginal gains and fine-tuning rather than basics (unless basics are clearly lacking).
- Be direct and analytical. They want real coaching, not encouragement.

===== HOW TO WATCH THE VIDEO =====
1. Watch the ENTIRE video from start to finish before forming any conclusions.
2. Pay attention to every single touch, movement, and transition.
3. Note the SPECIFIC skills, tricks, and techniques being performed — NAME THEM by their real names.
4. Track which foot (left/right) is being used for each action when visible.
5. Notice body mechanics: ankle lock, knee position, hip rotation, shoulder alignment, center of gravity.
6. Count approximate touches, note the rhythm, and observe consistency across attempts.

===== MULTI-PLAYER FOCUS RULES (CRITICAL) =====
If there are multiple players in the clip, you must identify ONE primary player and focus the analysis on that player only.
- Primary player selection priority:
  1) The player who touches the ball most often
  2) The player performing the key action repeatedly (especially receiving + executing)
  3) The player most central to the drill pattern (not background/support players)
- If one player repeatedly receives passes (ground or air), controls, and returns the ball, that receiving player is usually the primary player.
- Do NOT shift the report back and forth between different players. Keep the full report centered on the primary player.
- You may briefly mention teammates only as context (e.g., "teammate in red serves passes"), but all coaching feedback must be about the primary player.
- If jersey/shirt colors are visible, use them to keep identity consistent (e.g., "player in black receiving passes").
- If you cannot confidently track one player, say that clearly and explain the visibility limitation instead of mixing multiple players in one evaluation.

===== ACCURACY RULES (CRITICAL) =====
- Describe ONLY what you can actually see. Do NOT assume, guess, or hallucinate.
- If the player only uses their feet, do NOT say they used thighs or head.
- If the camera angle makes something unclear, say so explicitly.
- Be honest about what was done well AND what needs work. Do not sugarcoat.

===== UNDERSTAND INTENT vs OUTCOME (VERY IMPORTANT) =====
Do NOT confuse what the player is TRYING to do with what the ball happens to do.
- If a player is passing against a wall and the ball bounces back off the ground, that is NOT a volley. That is a WALL PASS DRILL where the ball happened to bounce. The player is practicing passing and receiving, not volleying.
- A volley is when a player INTENTIONALLY strikes the ball out of the air (e.g., a cross comes in and they hit it before it bounces). If the ball just bounces because of the surface, the wall, or a heavy touch, that is an uncontrolled bounce — NOT an intentional aerial technique.
- If the ball is bouncing and the player is clearly trying to get it under control or keep it on the ground, recognize that as a FIRST TOUCH / CONTROL issue, not as the player choosing to play in the air.
- Always ask yourself: "Is the player CHOOSING to do this, or is this happening because they haven't controlled the ball?" The answer changes the entire analysis.
- Common drill recognition:
  * Passing against a wall = wall pass drill (passing accuracy, first touch, weight of pass)
  * Ball bouncing off wall = natural rebound, not a volley unless player deliberately strikes it mid-air
  * Ball popping up after a touch = heavy/poor first touch, not intentional juggling
  * Player chasing a loose ball = loss of control, not a dribbling move

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

PASSING (including wall pass drills):
- Identify pass types: short pass, through ball, long ball, lofted pass, driven pass, outside-foot pass, backheel, cross, switch of play.
- Evaluate weight of pass (too hard, too soft, just right). Too hard = ball bounces back fast and high off the wall. Too soft = ball doesn't reach the target.
- Check technique: inside foot, laces, outside foot, which foot.
- Assess accuracy and intention vs result.
- WALL PASSING: If the player is passing against a wall and receiving the rebound, analyze the PASS WEIGHT (is the return bouncing or rolling?), the FIRST TOUCH on the rebound (can they control it quickly?), and BODY POSITIONING (are they preparing for the next pass?).
- If the ball keeps bouncing back instead of rolling, the player is hitting the ball too hard or striking too low. That's a pass weight issue, NOT a volley drill.
- Note if the player is working one-touch or two-touch patterns against the wall.

BALL CONTROL / FIRST TOUCH:
- Note receiving technique: inside foot, sole, outside foot, thigh, chest.
- Is the first touch setting them up for the next action or killing their momentum?
- Evaluate control under different scenarios (ground ball, aerial ball, bouncing ball off a wall).
- If the ball is bouncing and the player is trying to bring it down or keep it on the ground, that is a first touch PROBLEM to correct — not a different skill being practiced.
- A good first touch cushions the ball and keeps it close. A bad first touch lets the ball bounce away or pop up.

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
  "sessionSnapshot": {
    "levelScore": "numeric score from 0-10",
    "confidence": "High | Medium | Low",
    "quickTiles": [
      { "label": "First Touch", "value": "6.5/10", "note": "short reason" },
      { "label": "Consistency", "value": "7.0/10", "note": "short reason" },
      { "label": "Tempo", "value": "6.8/10", "note": "short reason" }
    ]
  },
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
  "trendVsLastSessions": [{"metric": "Passing Accuracy", "trend": "improving | flat | declining", "note": "short explanation"}],
  "nextSessionPlan": [{"block": "Warm-up", "duration": "5 min", "focus": "what to do"}, {"block": "Main Block", "duration": "10 min", "focus": "what to do"}],
  "youtubeRecommendations": [{"title": "specific video topic", "coach": "real YouTube channel name", "why": "how it addresses this player's specific needs"}]
}`;

  console.log('[BK] Sending video to Gemini...');

  const contentParts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ];

  let result;
  let usedModelName = GEMINI_MODELS[0];
  try {
    const out = await generateGeminiContent(contentParts, 'analyze');
    result = out.result;
    usedModelName = out.modelName;
  } catch (err) {
    if (isGeminiRetryable(err)) {
      throw new Error('Gemini quota/rate limit reached. Please retry shortly, or enable billing in Google AI Studio/Vertex for reliable analysis.');
    }
    throw err;
  }

  const rawContent = result.response.text();
  console.log(`[BK] Gemini (${usedModelName}) response (first 500 chars):`, rawContent.substring(0, 500));

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
    sessionSnapshot: data.sessionSnapshot || {},
    technicalAnalysis: data.technicalAnalysis || {},
    improvementTips: Array.isArray(data.improvementTips) ? data.improvementTips : [],
    commonMistakesForPosition: Array.isArray(data.commonMistakesForPosition) ? data.commonMistakesForPosition : [],
    practiceProgression: Array.isArray(data.practiceProgression) ? data.practiceProgression : [],
    trendVsLastSessions: Array.isArray(data.trendVsLastSessions) ? data.trendVsLastSessions : [],
    nextSessionPlan: Array.isArray(data.nextSessionPlan) ? data.nextSessionPlan : [],
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

app.get('/api/admin/stats', auth, async (req, res) => {
  try {
    const currentUser = await findUserById(req.userId);
    const isAdmin = ADMIN_EMAILS.includes(currentUser?.email?.toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    const safeCount = async (query, params = []) => {
      try {
        const { rows } = await pool.query(query, params);
        return parseInt(rows?.[0]?.count || 0, 10);
      } catch {
        return 0;
      }
    };

    const totalUsers = await safeCount('SELECT COUNT(*)::int AS count FROM users');
    const totalAnalyses = await safeCount('SELECT COUNT(*)::int AS count FROM analyses');
    const totalClips = await safeCount('SELECT COUNT(*)::int AS count FROM clips');
    const activeSubscriptions = await safeCount(
      "SELECT COUNT(*)::int AS count FROM users WHERE subscription_status = 'active'"
    );

    let topSkillFocuses = [];
    try {
      const { rows } = await pool.query(
        `SELECT skill_focus, COUNT(*)::int AS count
         FROM analyses
         WHERE skill_focus IS NOT NULL AND TRIM(skill_focus) <> ''
         GROUP BY skill_focus
         ORDER BY count DESC
         LIMIT 5`
      );
      topSkillFocuses = rows.map(r => ({ skill: r.skill_focus, count: r.count }));
    } catch {
      topSkillFocuses = [];
    }

    let createdAtRows = [];
    try {
      const { rows } = await pool.query('SELECT created_at FROM analyses ORDER BY created_at DESC LIMIT 5000');
      createdAtRows = rows || [];
    } catch {
      createdAtRows = [];
    }
    let userCreatedRows = [];
    try {
      const { rows } = await pool.query('SELECT created_at FROM users ORDER BY created_at DESC LIMIT 5000');
      userCreatedRows = rows || [];
    } catch {
      userCreatedRows = [];
    }
    const activeAnalyzers = await safeCount(
      'SELECT COUNT(DISTINCT user_id)::int AS count FROM analyses WHERE user_id IS NOT NULL'
    );

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    let analysesLast7d = 0;
    let analysesLast30d = 0;
    let latestAnalysisAt = null;

    for (const row of createdAtRows) {
      const t = toMs(row.created_at);
      if (!t) continue;
      if (!latestAnalysisAt || t > latestAnalysisAt) latestAnalysisAt = t;
      if (t >= monthAgo) analysesLast30d++;
      if (t >= weekAgo) analysesLast7d++;
    }

    const dayLabel = (ts) => {
      const d = new Date(ts);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}/${dd}`;
    };
    const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
    const countsByDay = new Map();
    const signupsByDay = new Map();

    for (const row of createdAtRows) {
      const t = toMs(row.created_at);
      if (!t || t < monthAgo) continue;
      const key = dayKey(t);
      countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
    }
    for (const row of userCreatedRows) {
      const t = toMs(row.created_at);
      if (!t || t < monthAgo) continue;
      const key = dayKey(t);
      signupsByDay.set(key, (signupsByDay.get(key) || 0) + 1);
    }

    const dailyAnalyses = [];
    const dailySignups = [];
    for (let i = 29; i >= 0; i--) {
      const t = now - i * 24 * 60 * 60 * 1000;
      const key = dayKey(t);
      dailyAnalyses.push({ label: dayLabel(t), value: countsByDay.get(key) || 0 });
      dailySignups.push({ label: dayLabel(t), value: signupsByDay.get(key) || 0 });
    }
    const weeklyBreakdown = dailyAnalyses.slice(-7);

    const freeUsers = Math.max(0, totalUsers - activeSubscriptions);
    const proConversionRate = totalUsers > 0
      ? Number(((activeSubscriptions / totalUsers) * 100).toFixed(1))
      : 0;
    const activeAnalyzerRate = totalUsers > 0
      ? Number(((activeAnalyzers / totalUsers) * 100).toFixed(1))
      : 0;

    return res.json({
      ok: true,
      stats: {
        totalUsers,
        totalAnalyses,
        totalClips,
        analysesLast7d,
        analysesLast30d,
        activeSubscriptions,
        freeUsers,
        proConversionRate,
        activeAnalyzers,
        activeAnalyzerRate,
        topSkillFocuses,
        latestAnalysisAt,
        dailyAnalyses,
        dailySignups,
        weeklyBreakdown,
        funnel: {
          signedUpUsers: totalUsers,
          activeAnalyzers,
          proSubscribers: activeSubscriptions,
        },
      },
    });
  } catch (e) {
    console.error('[BK] admin stats error:', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load admin stats' });
  }
});

app.post('/api/create-checkout-session', auth, async (req, res) => {
  if (!stripe) {
    return res.status(400).json({ ok: false, error: 'Stripe not configured' });
  }
  try {
    const currentUser = await findUserById(req.userId);
    const appUrl = `${req.protocol}://${req.get('host')}`;

    let priceId = STRIPE_PRICE_ID;

    if (!priceId) {
      const prices = await stripe.prices.list({ lookup_keys: [STRIPE_LOOKUP_KEY], limit: 1 });
      if (prices.data.length) {
        priceId = prices.data[0].id;
      } else {
        // Fallback: find first active recurring price
        const allPrices = await stripe.prices.list({ active: true, type: 'recurring', limit: 10 });
        if (allPrices.data.length) {
          priceId = allPrices.data[0].id;
          console.log(`[BK] Lookup key "${STRIPE_LOOKUP_KEY}" not found — using fallback price ${priceId}`);
        }
      }
    }

    if (!priceId) {
      return res.status(400).json({ ok: false, error: 'No subscription price configured in Stripe. Set STRIPE_PRICE_ID env var.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
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

app.post('/api/verify-checkout', auth, async (req, res) => {
  if (!stripe) {
    return res.status(400).json({ ok: false, error: 'Stripe not configured' });
  }
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.json({ ok: true, activated: false, reason: 'Payment not completed' });
    }

    const metaUserId = session.metadata?.userId;
    if (metaUserId !== req.userId) {
      return res.status(403).json({ ok: false, error: 'Session does not belong to this user' });
    }

    const customerId = session.customer;
    await pool.query(
      'UPDATE users SET subscription_status = $1, stripe_customer_id = $2 WHERE id = $3',
      ['active', customerId, req.userId]
    );
    console.log(`[BK] verify-checkout activated subscription for user ${req.userId}`);
    res.json({ ok: true, activated: true });
  } catch (e) {
    console.error('[BK] verify-checkout error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to verify checkout session' });
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
      candidateInfo,
    } = req.body || {};

    const requestedFocus = String(
      skill || candidateInfo?.focus || candidateInfo?.skill || ''
    ).trim() || null;

    console.log(`[BK] Analyze request - videoUrl: ${videoUrl ? 'present' : 'none'}, videoData: ${videoData ? 'present' : 'none'}, requestedFocus: ${requestedFocus || 'none'}`);

    if (!videoUrl && !videoData) {
      return res.status(400).json({ ok: false, error: 'Upload a training clip before analyzing.' });
    }

    await upsertProfile(req.userId, { height, heightFeet, heightInches, weight, foot, position, skill: requestedFocus });

    const profile = await getProfile(req.userId);
    const user = currentUser || {};

    const result = await runTextAnalysisForTraining({
      profile,
      user,
      videoUrl,
      videoData,
      skill: requestedFocus || profile.skill || null,
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
      sessionSnapshot: result.sessionSnapshot,
      technicalAnalysis: result.technicalAnalysis,
      improvementTips: result.improvementTips,
      commonMistakesForPosition: result.commonMistakesForPosition,
      practiceProgression: result.practiceProgression,
      trendVsLastSessions: result.trendVsLastSessions,
      nextSessionPlan: result.nextSessionPlan,
      youtubeRecommendations: result.youtubeRecommendations,
      video_url: videoUrl,
      public_id: publicId || null,
      skill: requestedFocus || profile.skill || null,
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
      sessionSnapshot: item.sessionSnapshot || {},
      technicalAnalysis: item.technicalAnalysis,
      improvementTips: item.improvementTips,
      commonMistakesForPosition: item.commonMistakesForPosition,
      practiceProgression: item.practiceProgression,
      trendVsLastSessions: item.trendVsLastSessions || [],
      nextSessionPlan: item.nextSessionPlan || [],
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

/* ==================================================================== */
/*                     PLAYER REPORT / TRENDS                           */
/* ==================================================================== */

app.get('/api/player-report', auth, async (req, res) => {
  try {
    const userId = req.userId;

    const { rows: statsRows } = await pool.query(
      'SELECT * FROM player_stats WHERE user_id = $1', [userId]
    );
    const stats = statsRows[0] || null;

    const { rows: analysisRows } = await pool.query(
      `SELECT id, skill_focus, secondary_skills, current_level, session_summary, created_at, raw
       FROM analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let skillFrequency  = stats?.skill_frequency  || {};
    let skillLevels     = stats?.skill_levels      || {};
    let skillLastSeen   = stats?.skill_last_seen   || {};
    let monthlyActivity = stats?.monthly_activity  || {};
    let totalAnalyses   = stats?.total_analyses    || 0;
    let lastAnalysisAt  = stats?.last_analysis_at  || null;

    // Fallback: derive from raw analyses rows for users who had analyses before player_stats existed
    if (!stats && analysisRows.length > 0) {
      for (const row of analysisRows) {
        const ts = toMs(row.created_at);
        const primarySkill = row.skill_focus || null;
        const secondary = Array.isArray(row.secondary_skills) ? row.secondary_skills : [];
        const allSkills = primarySkill ? [primarySkill, ...secondary] : secondary;
        const level = row.current_level || null;
        const d = new Date(ts);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

        for (const sk of allSkills) { if (sk) skillFrequency[sk] = (skillFrequency[sk] || 0) + 1; }
        if (primarySkill && level) skillLevels[primarySkill] = level;
        if (primarySkill && (!skillLastSeen[primarySkill] || ts > skillLastSeen[primarySkill])) {
          skillLastSeen[primarySkill] = ts;
        }
        if (!monthlyActivity[mk]) monthlyActivity[mk] = { sessions: 0, skills: [] };
        monthlyActivity[mk].sessions += 1;
        if (primarySkill && !monthlyActivity[mk].skills.includes(primarySkill)) {
          monthlyActivity[mk].skills.push(primarySkill);
        }
        totalAnalyses++;
        if (!lastAnalysisAt || ts > lastAnalysisAt) lastAnalysisAt = ts;
      }
    }

    const topSkills = Object.entries(skillFrequency)
      .sort((a, b) => b[1] - a[1])
      .map(([skill, count]) => ({
        skill, count,
        level: skillLevels[skill] || null,
        lastSeen: skillLastSeen[skill] || null,
      }));

    const currentMonthData = monthlyActivity[currentMonthKey] || { sessions: 0, skills: [] };

    const monthlyHistory = Object.entries(monthlyActivity)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-12)
      .map(([month, data]) => ({ month, sessions: data.sessions, skills: data.skills }));

    const recentSessions = analysisRows.slice(0, 5).map(r => ({
      id: r.id,
      skillFocus: r.skill_focus,
      currentLevel: r.current_level,
      sessionSummary: r.session_summary
        ? r.session_summary.slice(0, 200) + (r.session_summary.length > 200 ? '...' : '')
        : null,
      createdAt: toMs(r.created_at),
    }));

    res.json({
      ok: true,
      report: {
        totalAnalyses,
        lastAnalysisAt,
        topSkills,
        currentMonth: {
          month: currentMonthKey,
          sessions: currentMonthData.sessions,
          skillsTrained: currentMonthData.skills,
        },
        monthlyHistory,
        recentSessions,
        skillFrequency,
        skillLevels,
        skillLastSeen,
      },
    });
  } catch (e) {
    console.error('[BK] player-report error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to load player report' });
  }
});

app.get('/api/progress', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const skillFilter = String(req.query.skill || '').trim().toLowerCase();
    const range = String(req.query.range || '90').trim().toLowerCase();

    const { rows } = await pool.query(
      `SELECT id, skill_focus, current_level, session_summary, created_at, raw
       FROM analyses
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 2000`,
      [userId]
    );

    const levelFallback = (level) => {
      const l = String(level || '').toLowerCase();
      if (l.includes('advanced')) return 8.8;
      if (l.includes('beginner')) return 5.2;
      return 6.8;
    };

    const parseSnapshotScore = (raw, fallback) => {
      const candidate = raw?.sessionSnapshot?.levelScore;
      if (candidate === null || candidate === undefined) return fallback;
      const text = String(candidate).trim();
      if (!text) return fallback;
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) return fallback;
      const clean = text.endsWith('/10') ? text.replace('/10', '').trim() : text;
      const n = Number(clean);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, Math.min(10, n));
    };

    const now = Date.now();
    const rangeDays = range === 'all' ? null : Math.max(1, Number(range) || 90);
    const since = rangeDays ? (now - (rangeDays * 24 * 60 * 60 * 1000)) : null;

    const allSkillsSet = new Set();
    const points = [];
    for (const r of rows) {
      const ts = toMs(r.created_at);
      const skill = String(r.skill_focus || 'General').trim();
      const skillLower = skill.toLowerCase();
      allSkillsSet.add(skill);

      if (since && ts < since) continue;
      if (skillFilter && skillLower !== skillFilter) continue;

      const fallback = levelFallback(r.current_level);
      const score = parseSnapshotScore(r.raw, fallback);
      points.push({
        id: r.id,
        ts,
        label: new Date(ts).toLocaleDateString(),
        skill,
        level: r.current_level || 'Intermediate',
        score: Number(score.toFixed(1)),
        summary: r.session_summary
          ? r.session_summary.slice(0, 160) + (r.session_summary.length > 160 ? '...' : '')
          : '',
      });
    }

    const sessions = points.length;
    const firstScore = sessions ? points[0].score : null;
    const lastScore = sessions ? points[sessions - 1].score : null;
    const delta = (firstScore !== null && lastScore !== null)
      ? Number((lastScore - firstScore).toFixed(1))
      : null;
    const avgScore = sessions
      ? Number((points.reduce((sum, p) => sum + p.score, 0) / sessions).toFixed(1))
      : null;

    res.json({
      ok: true,
      progress: {
        skill: skillFilter || 'all',
        range,
        skills: Array.from(allSkillsSet).sort(),
        sessions,
        firstScore,
        lastScore,
        delta,
        avgScore,
        points,
      },
    });
  } catch (e) {
    console.error('[BK] progress error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to load progress' });
  }
});

app.post('/api/player-report/email', auth, async (req, res) => {
  try {
    if (!resend) return res.status(400).json({ ok: false, error: 'Email service not configured' });

    const userId = req.userId;
    const user = await findUserById(userId);
    const profile = await getProfile(userId);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const playerName  = profile?.name || user.name || 'Player';
    const playerEmail = user.email;

    const { rows: statsRows } = await pool.query(
      'SELECT * FROM player_stats WHERE user_id = $1', [userId]
    );
    const stats = statsRows[0] || null;

    const { rows: analysisRows } = await pool.query(
      `SELECT id, skill_focus, secondary_skills, current_level, session_summary, created_at, raw
       FROM analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    let skillFrequency  = stats?.skill_frequency  || {};
    let skillLevels     = stats?.skill_levels      || {};
    let monthlyActivity = stats?.monthly_activity  || {};
    let totalAnalyses   = stats?.total_analyses    || 0;

    if (!stats && analysisRows.length > 0) {
      for (const row of analysisRows) {
        const ts = toMs(row.created_at);
        const primarySkill = row.skill_focus || null;
        const secondary = Array.isArray(row.secondary_skills) ? row.secondary_skills : [];
        const allSkills = primarySkill ? [primarySkill, ...secondary] : secondary;
        const level = row.current_level || null;
        const d = new Date(ts);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

        for (const sk of allSkills) { if (sk) skillFrequency[sk] = (skillFrequency[sk] || 0) + 1; }
        if (primarySkill && level) skillLevels[primarySkill] = level;
        if (!monthlyActivity[mk]) monthlyActivity[mk] = { sessions: 0, skills: [] };
        monthlyActivity[mk].sessions += 1;
        if (primarySkill && !monthlyActivity[mk].skills.includes(primarySkill)) {
          monthlyActivity[mk].skills.push(primarySkill);
        }
        totalAnalyses++;
      }
    }

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const reportMonthLabel = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

    const currentMonthData = monthlyActivity[currentMonthKey] || { sessions: 0, skills: [] };

    const topSkills = Object.entries(skillFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([skill, count]) => ({ skill, count, level: skillLevels[skill] || 'N/A' }));

    const latestAnalysis = analysisRows[0] || null;
    const latestRaw = (latestAnalysis && latestAnalysis.raw && typeof latestAnalysis.raw === 'object') ? latestAnalysis.raw : {};
    const latestSummary = latestAnalysis?.session_summary || 'Keep stacking quality reps - your consistency improves session by session.';

    const priorityFixes = Array.isArray(latestRaw.improvementTips) ? latestRaw.improvementTips.slice(0, 3) : [];
    const priorityRowsHtml = priorityFixes.length
      ? priorityFixes.map((tip) => `
          <tr style="border-bottom:1px solid #1e2a3a">
            <td style="padding:10px 12px;color:#ffcc00;font-weight:700">${tip.priority || '-'}</td>
            <td style="padding:10px 12px;color:#e6e6e6">${tip.tip || '-'}</td>
            <td style="padding:10px 12px;color:#aaaaaa">${tip.why || '-'}</td>
            <td style="padding:10px 12px;color:#88d8ff">${tip.how || '-'}</td>
          </tr>`).join('')
      : `<tr><td colspan="4" style="padding:14px;color:#666;text-align:center">No priority fixes yet. Upload your next session to unlock this.</td></tr>`;

    const trendItems = Array.isArray(latestRaw.trendVsLastSessions) ? latestRaw.trendVsLastSessions.slice(0, 3) : [];
    const trendRowsHtml = trendItems.length
      ? trendItems.map((t) => {
          const tr = String(t.trend || 'flat').toLowerCase();
          const icon = tr.includes('improv') ? '▲' : (tr.includes('declin') ? '▼' : '►');
          const color = tr.includes('improv') ? '#00ff95' : (tr.includes('declin') ? '#ff6b6b' : '#cccccc');
          return `<div style="display:flex;justify-content:space-between;gap:10px;background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:10px 12px;margin-top:8px">
            <div>
              <div style="color:#ffffff;font-weight:600;font-size:14px">${t.metric || 'Metric'}</div>
              <div style="color:#888;font-size:12px">${t.note || ''}</div>
            </div>
            <div style="color:${color};font-weight:700;font-size:13px">${icon} ${t.trend || 'flat'}</div>
          </div>`;
        }).join('')
      : `<div style="color:#888;font-size:13px">Trend data appears after multiple analyzed sessions.</div>`;

    const nextSessionPlan = Array.isArray(latestRaw.nextSessionPlan) ? latestRaw.nextSessionPlan.slice(0, 3) : [];
    const nextPlanHtml = nextSessionPlan.length
      ? nextSessionPlan.map((s) => `
          <div style="display:grid;grid-template-columns:130px 1fr;gap:10px;background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:10px 12px;margin-top:8px">
            <div>
              <div style="color:#00ff95;font-weight:700;font-size:13px">${s.block || 'Block'}</div>
              <div style="color:#888;font-size:12px">${s.duration || ''}</div>
            </div>
            <div style="color:#e6e6e6;font-size:13px;line-height:1.5">${s.focus || s.drill || 'Training focus'}</div>
          </div>`).join('')
      : `
        <div style="display:grid;gap:8px">
          <div style="background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:10px 12px;color:#e6e6e6"><strong>Warm-up (5 min):</strong> ball mastery + mobility</div>
          <div style="background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:10px 12px;color:#e6e6e6"><strong>Main block (12 min):</strong> repeat your top priority correction drill</div>
          <div style="background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:10px 12px;color:#e6e6e6"><strong>Finisher (5 min):</strong> quality reps under pressure</div>
        </div>`;

    const recommendedVideos = Array.isArray(latestRaw.youtubeRecommendations) ? latestRaw.youtubeRecommendations.slice(0, 3) : [];
    const videoRowsHtml = recommendedVideos.length
      ? recommendedVideos.map((y) => `
          <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(y.title || 'soccer training')}" style="display:block;text-decoration:none;background:#111827;border:1px solid #1e2a3a;border-radius:10px;padding:10px 12px;margin-top:8px">
            <div style="color:#19d3ff;font-weight:700;font-size:14px">▶ ${y.title || 'Soccer training video'}</div>
            <div style="color:#888;font-size:12px;margin-top:4px">Channel: ${y.coach || 'Recommended Coach'}</div>
            <div style="color:#d1d5db;font-size:12px;margin-top:4px;line-height:1.5">${y.why || 'Matches your current focus and should improve execution quality.'}</div>
          </a>`).join('')
      : `<div style="color:#888;font-size:13px">Upload your next session to unlock targeted video recommendations.</div>`;

    const skillRowsHtml = topSkills.length > 0
      ? topSkills.map((s, i) => `
          <tr style="border-bottom:1px solid #1e2a3a">
            <td style="padding:12px 16px;color:#cccccc;font-size:15px">${i + 1}. ${s.skill}</td>
            <td style="padding:12px 16px;text-align:center">
              <span style="background:#0d1f2d;color:#00ff95;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:700">${s.count} session${s.count !== 1 ? 's' : ''}</span>
            </td>
            <td style="padding:12px 16px;text-align:center">
              <span style="color:${s.level === 'Advanced' ? '#00ff95' : s.level === 'Intermediate' ? '#19d3ff' : '#ffcc00'};font-size:13px;font-weight:600">${s.level}</span>
            </td>
          </tr>`).join('')
      : `<tr><td colspan="3" style="padding:16px;color:#666;text-align:center">No sessions recorded yet.</td></tr>`;

    const last3Months = Object.entries(monthlyActivity)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-3);

    const monthRowsHtml = last3Months.map(([mk, data]) => {
      const [yr, mo] = mk.split('-');
      const label = `${monthNames[parseInt(mo, 10) - 1]} ${yr}`;
      return `
        <tr style="border-bottom:1px solid #1e2a3a">
          <td style="padding:10px 16px;color:#cccccc;font-size:14px">${label}</td>
          <td style="padding:10px 16px;text-align:center;color:#19d3ff;font-weight:700">${data.sessions}</td>
          <td style="padding:10px 16px;color:#888;font-size:13px">${(data.skills || []).slice(0, 3).join(', ') || '—'}</td>
        </tr>`;
    }).join('');

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:620px;margin:0 auto;background:#0a0f1a;color:#ffffff;border-radius:16px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#00ff95,#19d3ff);padding:36px 32px;text-align:center">
          <div style="font-size:32px;margin-bottom:6px">⚽</div>
          <h1 style="margin:0;font-size:24px;color:#0a0a0a;font-weight:800">Ball Knowledge</h1>
          <p style="margin:6px 0 0;color:#0a0a0a;font-size:15px;opacity:0.75">${reportMonthLabel} Training Report</p>
        </div>
        <div style="padding:28px 32px 0">
          <h2 style="margin:0 0 8px;color:#00ff95;font-size:20px">Hey ${playerName},</h2>
          <p style="color:#aaaaaa;font-size:15px;line-height:1.7;margin:0">Here's your Ball Knowledge training summary. Keep up the work on the pitch!</p>
        </div>
        <div style="padding:24px 32px">
          <div style="background:#111827;border-radius:12px;padding:20px;text-align:center;display:flex">
            <div style="flex:1;border-right:1px solid #1e2a3a;padding-right:16px">
              <div style="font-size:36px;font-weight:800;color:#00ff95">${currentMonthData.sessions}</div>
              <div style="color:#888;font-size:13px;margin-top:4px">Sessions This Month</div>
            </div>
            <div style="flex:1;border-right:1px solid #1e2a3a;padding:0 16px">
              <div style="font-size:36px;font-weight:800;color:#19d3ff">${totalAnalyses}</div>
              <div style="color:#888;font-size:13px;margin-top:4px">Total Sessions</div>
            </div>
            <div style="flex:1;padding-left:16px">
              <div style="font-size:36px;font-weight:800;color:#ffcc00">${topSkills.length}</div>
              <div style="color:#888;font-size:13px;margin-top:4px">Skills Practiced</div>
            </div>
          </div>
        </div>
        <div style="padding:0 32px 22px">
          <h3 style="margin:0 0 12px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Coach's Summary</h3>
          <div style="background:#111827;border:1px solid #1e2a3a;border-radius:12px;padding:14px 16px;color:#d7d7d7;line-height:1.7;font-size:14px">
            ${latestSummary}
          </div>
        </div>
        <div style="padding:0 32px 22px">
          <h3 style="margin:0 0 12px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Priority Fixes</h3>
          <table style="width:100%;border-collapse:collapse;background:#111827;border-radius:12px;overflow:hidden">
            <thead>
              <tr style="background:#0d1f2d">
                <th style="padding:10px 12px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase">Priority</th>
                <th style="padding:10px 12px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase">Fix</th>
                <th style="padding:10px 12px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase">Why</th>
                <th style="padding:10px 12px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase">Drill</th>
              </tr>
            </thead>
            <tbody>${priorityRowsHtml}</tbody>
          </table>
        </div>
        <div style="padding:0 32px 22px">
          <h3 style="margin:0 0 12px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Trend vs Last Sessions</h3>
          ${trendRowsHtml}
        </div>
        <div style="padding:0 32px 22px">
          <h3 style="margin:0 0 12px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Next Session Plan</h3>
          ${nextPlanHtml}
        </div>
        <div style="padding:0 32px 22px">
          <h3 style="margin:0 0 12px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Recommended Videos</h3>
          ${videoRowsHtml}
        </div>
        <div style="padding:0 32px 24px">
          <h3 style="margin:0 0 16px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Top Skills (All Time)</h3>
          <table style="width:100%;border-collapse:collapse;background:#111827;border-radius:12px;overflow:hidden">
            <thead>
              <tr style="background:#0d1f2d">
                <th style="padding:10px 16px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Skill</th>
                <th style="padding:10px 16px;text-align:center;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Sessions</th>
                <th style="padding:10px 16px;text-align:center;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Level</th>
              </tr>
            </thead>
            <tbody>${skillRowsHtml}</tbody>
          </table>
        </div>
        ${last3Months.length > 0 ? `
        <div style="padding:0 32px 24px">
          <h3 style="margin:0 0 16px;color:#ffffff;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Recent Months</h3>
          <table style="width:100%;border-collapse:collapse;background:#111827;border-radius:12px;overflow:hidden">
            <thead>
              <tr style="background:#0d1f2d">
                <th style="padding:10px 16px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Month</th>
                <th style="padding:10px 16px;text-align:center;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Sessions</th>
                <th style="padding:10px 16px;text-align:left;color:#888;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px">Skills</th>
              </tr>
            </thead>
            <tbody>${monthRowsHtml}</tbody>
          </table>
        </div>` : ''}
        <div style="padding:0 32px 32px;text-align:center">
          <a href="https://smusoni.github.io/ai-soccer-backend-2" style="background:linear-gradient(135deg,#00ff95,#19d3ff);color:#0a0a0a;text-decoration:none;padding:14px 40px;border-radius:12px;font-weight:700;font-size:16px;display:inline-block;margin-top:8px">
            Analyze Your Next Session
          </a>
        </div>
        <div style="border-top:1px solid #1e2a3a;padding:20px 32px;text-align:center">
          <p style="color:#555;font-size:12px;margin:0">Ball Knowledge · Analyze. Improve. Dominate.</p>
          <p style="color:#444;font-size:11px;margin:6px 0 0">You requested this report from your Ball Knowledge account.</p>
        </div>
      </div>`;

    await resend.emails.send({
      from: 'Ball Knowledge <onboarding@resend.dev>',
      to: playerEmail,
      subject: `Your ${reportMonthLabel} Training Report — Ball Knowledge`,
      html,
    });

    console.log(`[BK] Monthly report emailed to ${playerEmail}`);
    res.json({ ok: true, message: `Report sent to ${playerEmail}` });
  } catch (e) {
    console.error('[BK] player-report/email error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to send report email' });
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
