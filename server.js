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

const JWT_SECRET  = process.env.JWT_SECRET  || 'dev_secret_change_me';
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';
const CLOUD_NAME  = process.env.CLOUD_NAME || ''; // for future frame URLs (Part 2)
const APP_ORIGINS = (process.env.APP_ORIGINS || 'https://smusoni.github.io,http://localhost:8080')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* -------------------- Setup -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors({ origin: APP_ORIGINS, credentials: false }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static('.'));

const PORT = process.env.PORT || 8080;

/* -------------------- JSON "DB" -------------------- */
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

let db = {
  users: [],            // [{ id, name, email, passHash, age, dob, ... }]
  profiles: {},         // userId -> profile
  clipsByUser: {},      // userId -> [clips]
  analysesByUser: {},   // userId -> [analyses]
  ownerByPublicId: {}   // public_id -> userId
};

function ensureDataDir(){
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadDB(){
  try{
    ensureDataDir();
    if (fs.existsSync(DATA_PATH)){
      db = { ...db, ...JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) };
    }
  }catch(e){
    console.error('[BK] loadDB', e);
  }
}
let saveTimer = null;
function saveDB(immediate = false){
  const write = () => fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
  ensureDataDir();
  if (immediate) return write();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { write(); } catch(e){ console.error('[BK] save', e); }
    saveTimer = null;
  }, 250);
}
loadDB();

/* -------------------- Helpers -------------------- */
const findUser     = (email) => db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
const findUserById = (id)    => db.users.find(u => u.id === id);

function auth(req,res,next){
  try{
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok:false, error:'Missing token' });
    const p = jwt.verify(token, JWT_SECRET);
    req.userId = p.sub;
    next();
  }catch{
    res.status(401).json({ ok:false, error:'Invalid token' });
  }
}

/* -------------------- OpenAI client -------------------- */
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* -------------------- Misc -------------------- */
app.get('/', (_req,res)=> res.send('BallKnowledge backend (Part 1 training clips) ✅'));
app.get('/api/health', (_req,res)=> res.json({ ok:true, uptime:process.uptime() }));

/* -------------------- Auth -------------------- */
app.post('/api/signup', async (req,res)=>{
  try{
    const { name, email, password, age, dob } = req.body || {};
    if (!name || !email || !password || !age || !dob){
      return res.status(400).json({ ok:false, error:'All fields required' });
    }
    if (findUser(email)){
      return res.status(409).json({ ok:false, error:'Email already registered' });
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

    const token = jwt.sign({ sub:id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ ok:true, token, user:{ id, name:user.name, email:user.email } });
  }catch(e){
    console.error('[BK] signup', e);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

app.post('/api/login', async (req,res)=>{
  try{
    const { email, password } = req.body || {};
    if (!email || !password){
      return res.status(400).json({ ok:false, error:'Email and password required' });
    }
    const user = findUser(email);
    if (!user) return res.status(401).json({ ok:false, error:'Invalid credentials' });

    const ok = await bcrypt.compare(String(password), user.passHash);
    if (!ok) return res.status(401).json({ ok:false, error:'Invalid credentials' });

    const token = jwt.sign({ sub:user.id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ ok:true, token, user:{ id:user.id, name:user.name, email:user.email } });
  }catch(e){
    console.error('[BK] login', e);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

app.get('/api/me', auth, (req,res)=>{
  const u = findUserById(req.userId);
  if (!u) return res.status(404).json({ ok:false, error:'User not found' });
  res.json({ ok:true, user:{ id:u.id, name:u.name, email:u.email } });
});

/* -------------------- Profile -------------------- */
/**
 * We store height internally in total inches,
 * but accept either:
 *  - "height" (inches)
 *  - or { heightFeet, heightInches } from the frontend
 * We also store "skill" = what they’re currently working on.
 */
function upsertProfile(userId, body){
  const existing = db.profiles[userId] || {};
  let heightInches = existing.height ?? null;

  // feet + inches from frontend
  if (body.heightFeet != null || body.heightInches != null){
    const ft   = Number(body.heightFeet || 0);
    const inch = Number(body.heightInches || 0);
    const total = ft * 12 + inch;
    if (total > 0) heightInches = total;
  } else if (body.height != null){
    const h = Number(body.height);
    if (!Number.isNaN(h) && h > 0) heightInches = h;
  }

  db.profiles[userId] = {
    ...existing,
    height:   heightInches,
    weight:   body.weight   ?? existing.weight ?? null,
    foot:     body.foot     ?? existing.foot ?? null,
    position: body.position ?? existing.position ?? null,
    dob:      body.dob      ?? existing.dob ?? null,
    age:      body.age      ?? existing.age ?? findUserById(userId)?.age ?? null,
    name:     body.name     ?? existing.name ?? null,
    skill:    body.skill    ?? existing.skill ?? null,
    updatedAt: Date.now()
  };
}

app.get('/api/profile', auth, (req,res)=>{
  res.json({
    ok:true,
    profile: db.profiles[req.userId] || {},
    clips:   db.clipsByUser[req.userId] || [],
    analysis:(db.analysesByUser[req.userId] || [])[0] || null
  });
});

app.put('/api/profile', auth, (req,res)=>{
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok:true, profile: db.profiles[req.userId] });
});

app.post('/api/profile', auth, (req,res)=>{
  upsertProfile(req.userId, req.body || {});
  saveDB();
  res.json({ ok:true, profile: db.profiles[req.userId] });
});

/* -------------------- Clips -------------------- */
app.post('/api/clip', auth, (req,res)=>{
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  if (!url && !public_id){
    return res.status(400).json({ ok:false, error:'url or public_id required' });
  }
  if (!Array.isArray(db.clipsByUser[req.userId])) db.clipsByUser[req.userId] = [];

  const clip = {
    url:        url || null,
    public_id:  public_id || null,
    created_at: created_at || new Date().toISOString(),
    bytes:      Number(bytes)    || null,
    duration:   Number(duration) || null,
    width:      Number(width)    || null,
    height:     Number(height)   || null,
    format:     format || null
  };

  db.clipsByUser[req.userId].unshift(clip);
  if (public_id) db.ownerByPublicId[public_id] = req.userId;
  saveDB();
  res.json({ ok:true, clip, total: db.clipsByUser[req.userId].length });
});

/* -------------------- Library -------------------- */
app.get('/api/analyses', auth, (req,res)=>{
  res.json({ ok:true, items: db.analysesByUser[req.userId] || [] });
});

app.post('/api/analyses', auth, (req,res)=>{
  const { summary, focus, drills, videoUrl, publicId, raw, skill } = req.body || {};
  if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
  const item = {
    id: uuidv4(),
    summary: summary || '',
    focus:   Array.isArray(focus)  ? focus  : [],
    drills:  Array.isArray(drills) ? drills : [],
    video_url:  videoUrl || null,
    public_id:  publicId || null,
    skill:      skill || null,
    raw:        raw || null,
    created_at: Date.now()
  };
  db.analysesByUser[req.userId].unshift(item);
  saveDB();
  res.json({ ok:true, item });
});

app.get('/api/analyses/:id', auth, (req,res)=>{
  const list = db.analysesByUser[req.userId] || [];
  const item = list.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok:false, error:'Not found' });
  res.json({ ok:true, item });
});

app.delete('/api/analyses/:id', auth, (req,res)=>{
  const list = db.analysesByUser[req.userId] || [];
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok:false, error:'Not found' });
  list.splice(idx,1);
  db.analysesByUser[req.userId] = list;
  saveDB();
  res.json({ ok:true });
});

/* --------------- Part 1: REAL-TIME TRAINING ANALYZE --------------- */
/**
 * When you hit "Analyze" on the frontend:
 * - frontend sends: heightFeet, heightInches, weight, foot, position, skill, videoUrl
 * - backend updates profile
 * - backend calls OpenAI and gets full JSON report
 * - backend saves report to Library
 * - backend returns full report immediately to the frontend
 */
async function runTextAnalysisForTraining({ profile, user, videoUrl, skill }){
  if (!openai){
    // Fallback if API key missing
    const genericSummary = `Quick training analysis for ${profile.position || 'your role'}. Keep focusing on clean technique and smart decisions.`;
    return {
      summary: genericSummary,
      focus: [
        'Technical repetition with correct body shape',
        'Decision making under light pressure',
        'Consistent first touch and preparation touch'
      ],
      drills: [
        { title:'Wall passes with tight touch', url:'https://youtu.be/ZNk6NIxPkb0' },
        { title:'1v1 change-of-direction drill', url:'https://youtu.be/0W2bXg2NaqE' },
        { title:'First-touch receiving patterns', url:'https://youtu.be/x7Jr8OZnS7U' }
      ],
      raw: {}
    };
  }

  const age      = profile.age ?? user?.age ?? null;
  const isYouth  = age != null ? Number(age) < 18 : false;
  const heightIn = profile.height || null;
  const weightLb = profile.weight || null;

  const sys = `You are a soccer performance trainer working 1:1 with players.
Return STRICT JSON ONLY with fields:

{
  "summary": string,           // 3–6 sentences, direct and encouraging
  "focus": string[3..6],       // bullet-level phrases describing what to focus on
  "drills": [                  // 3–6 drills, each with title + url
    { "title": string, "url": string }
  ]
}

Guidelines:
- Tailor everything to THIS specific player (age, position, foot, skill).
- Assume the attached training clip shows them working on that skill (shooting, dribbling, first touch, etc.).
- If they’re youth, keep language simple and supportive.
- Be specific about HOW to fix technique (body shape, contact point, timing), not just "work harder".
- Do NOT mention JSON, keys, or that you are an AI. Just output valid JSON.`;

  const context = {
    name: user?.name || null,
    age,
    isYouth,
    position:      profile.position || 'Unknown',
    dominantFoot:  profile.foot || 'Unknown',
    heightIn,
    weightLb,
    skillWorkingOn: skill || profile.skill || null,
    videoUrl
  };

  const userText = `
Player context: ${JSON.stringify(context, null, 2)}

Assume the clip is them working on that specific skill in training.
Give coaching feedback as if you watched the clip and want them to get better for their next session.
Focus on:
- 2–3 key technical fixes
- 1–2 decision making points (if relevant)
- A few drills or progressions that directly match this skill.`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role:'system', content: sys },
      { role:'user',   content: userText }
    ]
  });

  const rawContent = resp.choices?.[0]?.message?.content || '{}';
  const jsonText   = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);

  let data = {};
  try {
    data = JSON.parse(jsonText);
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }

  return {
    summary: data.summary || 'Training analysis complete.',
    focus:   Array.isArray(data.focus)  ? data.focus.slice(0,6)   : [],
    drills:  Array.isArray(data.drills) ? data.drills.slice(0,6)  : [],
    raw:     data
  };
}

app.post('/api/analyze', auth, async (req,res)=>{
  try{
    const {
      height, heightFeet, heightInches,
      weight, foot, position,
      videoUrl, publicId,
      skill
    } = req.body || {};

    if (!videoUrl){
      return res.status(400).json({ ok:false, error:'Video URL required' });
    }

    // Update profile with latest info (so each player has their own data)
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

    // REAL-TIME call to OpenAI
    const result = await runTextAnalysisForTraining({
      profile,
      user,
      videoUrl,
      skill: skill || profile.skill || null
    });

    // Save into Library immediately so "View" works
    if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
    const item = {
      id: uuidv4(),
      summary:   result.summary,
      focus:     result.focus,
      drills:    result.drills,
      video_url: videoUrl,
      public_id: publicId || null,
      skill:     skill || profile.skill || null,
      raw:       result.raw,
      created_at: Date.now()
    };
    db.analysesByUser[req.userId].unshift(item);
    saveDB();

    // Return full report right away to the frontend
    res.json({
      ok: true,
      summary: result.summary,
      focus:   result.focus,
      drills:  result.drills,
      videoUrl,
      publicId,
      skill:   item.skill
    });
  }catch(e){
    console.error('[BK] analyze', e);
    res.status(500).json({ ok:false, error:'Analysis failed' });
  }
});

/* ---------- Webhook + Vision Worker (kept for Part 2, not used now) ---------- */

const jobQueue = [];
let workerBusy = false;

app.post('/webhooks/cloudinary', express.json({ limit:'1mb' }), async (req,res)=>{
  try{
    const body = req.body || {};
    const public_id = body.public_id || body.asset_id || body?.info?.public_id;
    const duration  = Number(body.duration || body.video?.duration || 0);
    if (!public_id){
      console.log('[WH] missing public_id');
      return res.status(200).json({ ok:true });
    }

    const userId = db.ownerByPublicId[public_id];
    if (!userId){
      console.log('[WH] unknown owner for', public_id);
      return res.status(200).json({ ok:true });
    }

    const clip = (db.clipsByUser[userId] || []).find(c => c.public_id === public_id) || null;
    const videoUrl = clip?.url || (CLOUD_NAME ? `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/${public_id}.mp4` : null);

    jobQueue.push({ userId, public_id, videoUrl, duration });
    processJobs().catch(()=>{});

    res.status(200).json({ ok:true });
  }catch(e){
    console.error('[WH] error', e);
    res.status(200).json({ ok:true });
  }
});

async function processJobs(){
  if (workerBusy) return;
  workerBusy = true;
  while (jobQueue.length){
    const job = jobQueue.shift();
    try { await runAnalysisJob(job); }
    catch(e){ console.error('[JOB] failed', e); }
  }
  workerBusy = false;
}

function sampleFrameUrls({ public_id, duration, n = 10 }){
  const secs  = [];
  const total = Math.max(8, Math.min(n, 16));
  const span  = Math.max(1, Math.floor((duration || 60) / (total + 1)));
  for (let i=1; i<=total; i++) secs.push(i * span);
  return secs.map(s => `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/so_${s}/${public_id}.jpg`);
}

async function analyzeWithOpenAI({ frames, context }){
  if (!openai) throw new Error('OPENAI_API_KEY missing');

  const sys = `You are a soccer performance analyst. Return strict JSON with:
{
  "summary": string,
  "focus": string[3..6],
  "drills": [{ "title": string, "url": string }] (3..6)
}
Keep it specific and constructive.`;

  const userMsg = [
    {
      type:'text',
      text:`Context: ${JSON.stringify(context)}.
Frames below are ordered in time; describe patterns you see (movement, decisions, technique).
Return STRICT JSON only.`
    },
    ...frames.map(url => ({ type:'input_image', image_url: { url } }))
  ];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages: [
      { role:'system', content: sys },
      { role:'user',   content: userMsg }
    ]
  });

  const raw = resp.choices?.[0]?.message?.content || '{}';
  const jsonText = typeof raw === 'string' ? raw : JSON.stringify(raw);

  let data = {};
  try { data = JSON.parse(jsonText); }
  catch{
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }

  return {
    summary: data.summary || 'Video analysis complete.',
    focus:   Array.isArray(data.focus)  ? data.focus.slice(0,6)  : [],
    drills:  Array.isArray(data.drills) ? data.drills.slice(0,6) : []
  };
}

async function runAnalysisJob({ userId, public_id, videoUrl, duration }){
  const profile = db.profiles[userId] || {};
  const user    = findUserById(userId) || {};
  const age     = profile.age ?? user.age ?? null;
  const isYouth = age != null ? Number(age) < 18 : false;

  if (!CLOUD_NAME) throw new Error('CLOUD_NAME env is required for frame URLs');
  const frames = sampleFrameUrls({ public_id, duration, n: isYouth ? 8 : 12 });

  const context = {
    role:   profile.position || 'Unknown',
    foot:   profile.foot || 'Unknown',
    age,
    isYouth,
    height: profile.height || null,
    weight: profile.weight || null
  };

  const { summary, focus, drills } = await analyzeWithOpenAI({ frames, context });

  if (!Array.isArray(db.analysesByUser[userId])) db.analysesByUser[userId] = [];
  const item = {
    id: uuidv4(),
    summary, focus, drills,
    video_url: videoUrl || null,
    public_id,
    frames,
    created_at: Date.now()
  };
  db.analysesByUser[userId].unshift(item);
  saveDB();
  console.log('[JOB] saved analysis for user', userId, 'public_id', public_id);
}

/* -------------------- Start -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Soccer backend running on ${PORT}`);
});
