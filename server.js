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
const CLOUD_NAME  = process.env.CLOUD_NAME || ''; // for frame URLs
const APP_ORIGINS = (process.env.APP_ORIGINS || 'https://smusoni.github.io,http://localhost:8080')
  .split(',').map(s => s.trim()).filter(Boolean);

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
  users: [],
  profiles: {},
  clipsByUser: {},
  analysesByUser: {},
  ownerByPublicId: {} // NEW: public_id -> userId
};

function ensureDataDir(){ if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function loadDB(){
  try{
    ensureDataDir();
    if (fs.existsSync(DATA_PATH)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) };
  }catch(e){ console.error('[BK] loadDB', e); }
}
let saveTimer=null;
function saveDB(immediate=false){
  const write = ()=> fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
  ensureDataDir();
  if (immediate) return write();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{ try{ write(); }catch(e){ console.error('[BK] save', e);} saveTimer=null; }, 250);
}
loadDB();

/* -------------------- Helpers -------------------- */
const findUser      = (email) => db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
const findUserById  = (id)    => db.users.find(u => u.id === id);
function auth(req,res,next){
  try{
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok:false, error:'Missing token' });
    const p = jwt.verify(token, JWT_SECRET);
    req.userId = p.sub;
    next();
  }catch{ res.status(401).json({ ok:false, error:'Invalid token' }); }
}

/* -------------------- OpenAI client -------------------- */
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* -------------------- Misc -------------------- */
app.get('/', (_req,res)=> res.send('ai-soccer-backend (webhook + vision) ✅'));
app.get('/api/health', (_req,res)=> res.json({ ok:true, uptime:process.uptime() }));

/* -------------------- Auth -------------------- */
app.post('/api/signup', async (req,res)=>{
  try{
    const { name, email, password, age, dob } = req.body || {};
    if (!name || !email || !password || !age || !dob) return res.status(400).json({ ok:false, error:'All fields required' });
    if (findUser(email)) return res.status(409).json({ ok:false, error:'Email already registered' });
    const id = uuidv4();
    const passHash = await bcrypt.hash(String(password), 10);
    const user = { id, name:String(name).trim(), email:String(email).trim().toLowerCase(), passHash, age:Number(age), dob:String(dob).trim(), createdAt:Date.now() };
    db.users.push(user); saveDB();
    const token = jwt.sign({ sub:id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ ok:true, token, user:{ id, name:user.name, email:user.email } });
  }catch(e){ console.error('[BK] signup', e); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.post('/api/login', async (req,res)=>{
  try{
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:'Email and password required' });
    const user = findUser(email);
    if (!user) return res.status(401).json({ ok:false, error:'Invalid credentials' });
    const ok = await bcrypt.compare(String(password), user.passHash);
    if (!ok) return res.status(401).json({ ok:false, error:'Invalid credentials' });
    const token = jwt.sign({ sub:user.id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ ok:true, token, user:{ id:user.id, name:user.name, email:user.email } });
  }catch(e){ console.error('[BK] login', e); res.status(500).json({ ok:false, error:'Server error' }); }
});

app.get('/api/me', auth, (req,res)=>{
  const u = findUserById(req.userId);
  if (!u) return res.status(404).json({ ok:false, error:'User not found' });
  res.json({ ok:true, user:{ id:u.id, name:u.name, email:u.email } });
});

/* -------------------- Profile -------------------- */
function upsertProfile(userId, body){
  db.profiles[userId] = {
    ...(db.profiles[userId] || {}),
    height:  body.height  ?? db.profiles[userId]?.height ?? null,
    weight:  body.weight  ?? db.profiles[userId]?.weight ?? null,
    foot:    body.foot    ?? db.profiles[userId]?.foot ?? null,
    position:body.position?? db.profiles[userId]?.position ?? null,
    dob:     body.dob     ?? db.profiles[userId]?.dob ?? null,
    age:     body.age     ?? db.profiles[userId]?.age ?? findUserById(userId)?.age ?? null,
    name:    body.name    ?? db.profiles[userId]?.name ?? null,
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
app.put('/api/profile', auth, (req,res)=>{ upsertProfile(req.userId, req.body||{}); saveDB(); res.json({ ok:true, profile: db.profiles[req.userId] }); });
app.post('/api/profile',auth,(req,res)=>{ upsertProfile(req.userId, req.body||{}); saveDB(); res.json({ ok:true, profile: db.profiles[req.userId] }); });

/* -------------------- Clips -------------------- */
app.post('/api/clip', auth, (req,res)=>{
  const { url, public_id, created_at, bytes, duration, width, height, format } = req.body || {};
  if (!url && !public_id) return res.status(400).json({ ok:false, error:'url or public_id required' });
  if (!Array.isArray(db.clipsByUser[req.userId])) db.clipsByUser[req.userId] = [];
  const clip = {
    url: url || null,
    public_id: public_id || null,
    created_at: created_at || new Date().toISOString(),
    bytes: Number(bytes) || null,
    duration: Number(duration) || null,
    width: Number(width) || null,
    height: Number(height) || null,
    format: format || null
  };
  db.clipsByUser[req.userId].unshift(clip);
  if (public_id) db.ownerByPublicId[public_id] = req.userId; // map owner
  saveDB();
  res.json({ ok:true, clip, total: db.clipsByUser[req.userId].length });
});

/* -------------------- Library -------------------- */
app.get('/api/analyses', auth, (req,res)=>{
  res.json({ ok:true, items: db.analysesByUser[req.userId] || [] });
});
app.post('/api/analyses', auth, (req,res)=>{
  const { summary, focus, drills, comps, videoUrl, publicId, raw } = req.body || {};
  if (!Array.isArray(db.analysesByUser[req.userId])) db.analysesByUser[req.userId] = [];
  const item = {
    id: uuidv4(),
    summary: summary || '',
    focus: Array.isArray(focus)?focus:[],
    drills:Array.isArray(drills)?drills:[],
    comps: Array.isArray(comps)?comps:[],
    video_url: videoUrl || null,
    public_id: publicId || null,
    raw: raw || null,
    created_at: Date.now()
  };
  db.analysesByUser[req.userId].unshift(item);
  saveDB();
  res.json({ ok:true, item });
});
app.get('/api/analyses/:id', auth, (req,res)=>{
  const list = db.analysesByUser[req.userId] || [];
  const item = list.find(x=>x.id===req.params.id);
  if (!item) return res.status(404).json({ ok:false, error:'Not found' });
  res.json({ ok:true, item });
});
app.delete('/api/analyses/:id', auth, (req,res)=>{
  const list = db.analysesByUser[req.userId] || [];
  const idx = list.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).json({ ok:false, error:'Not found' });
  list.splice(idx,1); db.analysesByUser[req.userId]=list; saveDB();
  res.json({ ok:true });
});

/* -------------------- Sync fallback analyzer (kept) -------------------- */
app.post('/api/analyze', auth, (req,res)=>{
  try{
    const { height=0, weight=0, foot='', position='', videoUrl='' } = req.body || {};
    if (!videoUrl) return res.status(400).json({ ok:false, error:'Video URL required' });

    const profile = db.profiles[req.userId] || {};
    const user = findUserById(req.userId);
    const age = profile.age ?? user?.age ?? null;
    const isYouth = age != null ? Number(age) < 18 : false;

    const FOCUS = {
      'Attacking Mid': ['Half-space positioning','Final-third decision speed','Cut-back creation','Weak-foot development'],
      'Striker': ['Front-post timing','Hold-up touch','Peel blind side','Finishing body shape']
    };
    const pos = FOCUS[position] ? position : 'Attacking Mid';
    const focus = FOCUS[pos].slice(0,3 + (height && height>72 ? 1:0));
    const drills = [
      { title:'Rondo 4v2', url:'https://youtu.be/3z1mP-rondo' },
      { title: isYouth ? 'Rondo 4v1 (guided)':'1v1 transition box', url: isYouth?'https://youtu.be/rondo-4v1':'https://youtu.be/1v1-transition' },
      { title:'100 weak-foot reps', url:'https://youtu.be/weak-foot-100' }
    ];
    const comps = pos==='Striker' ? ['Erling Haaland','Lautaro Martínez'] : ['Phil Foden','Martin Ødegaard'];

    const hIn = Number(height)||0, wLb = Number(weight)||0;
    const phys = (hIn && wLb) ? `(${hIn} in / ${wLb} lbs)` : '';
    const summary = `As a ${foot?foot.toLowerCase()+'-footed ':''}${pos}${isYouth?' (youth focus)':''}, you show promising tendencies. ${phys ? 'Profile '+phys+'. ':''}This is a quick preview; a full analysis will update shortly.`;

    res.json({ ok:true, summary, focus, drills, comps, videoUrl, createdAt: Date.now() });
  }catch(e){ console.error('[BK] analyze', e); res.status(500).json({ ok:false, error:'Analysis failed' }); }
});

/* -------------------- Webhook + Worker (OpenAI Vision) -------------------- */

/** Very small in-memory queue */
const jobQueue = [];
let workerBusy = false;

/** Cloudinary webhook: set your Upload Preset → **Notification URL** to this endpoint.
 *  We expect a JSON payload that includes at least public_id and duration (if available).
 */
app.post('/webhooks/cloudinary', express.json({ limit:'1mb' }), async (req,res)=>{
  try{
    const body = req.body || {};
    // Example events to accept: 'upload','create','completed','derived_create'
    const public_id = body.public_id || body.asset_id || body?.info?.public_id;
    const duration  = Number(body.duration || body.video?.duration || 0);
    if (!public_id){ console.log('[WH] missing public_id'); return res.status(200).json({ ok:true }); }

    const userId = db.ownerByPublicId[public_id];
    if (!userId){ console.log('[WH] unknown owner for', public_id); return res.status(200).json({ ok:true }); }

    const clip = (db.clipsByUser[userId]||[]).find(c => c.public_id === public_id) || null;
    const videoUrl = clip?.url || (CLOUD_NAME ? `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/${public_id}.mp4` : null);

    // enqueue
    jobQueue.push({ userId, public_id, videoUrl, duration });
    processJobs().catch(()=>{});

    res.status(200).json({ ok:true });
  }catch(e){
    console.error('[WH] error', e);
    res.status(200).json({ ok:true }); // reply 200 so Cloudinary won’t retry forever during dev
  }
});

async function processJobs(){
  if (workerBusy) return;
  workerBusy = true;
  while (jobQueue.length){
    const job = jobQueue.shift();
    try{ await runAnalysisJob(job); }
    catch(e){ console.error('[JOB] failed', e); }
  }
  workerBusy = false;
}

/** Build N frame URLs from the video at evenly-spaced seconds */
function sampleFrameUrls({ public_id, duration, n=10 }){
  const secs = [];
  const total = Math.max(8, Math.min(n, 16));
  const span = Math.max(1, Math.floor((duration || 60) / (total+1)));
  for (let i=1;i<=total;i++) secs.push(i*span);
  // Cloudinary: so_{sec} and request jpg frame
  return secs.map(s => `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/so_${s}/${public_id}.jpg`);
}

/** Call OpenAI Vision with frames + context, expect JSON back */
async function analyzeWithOpenAI({ frames, context }){
  if (!openai) throw new Error('OPENAI_API_KEY missing');
  const sys = `You are a soccer performance analyst. Return strict JSON with:
{
  "summary": string,
  "focus": string[3..6],
  "drills": [{"title": string, "url": string}] (3..6),
  "comps": string[2..4]  // similar pro players
}
Keep it specific and constructive.`;

  const userMsg = [
    { type:'text', text:
      `Context: ${JSON.stringify(context)}.
Frames below are ordered in time; describe patterns you see (movement, decisions, technique).
Return STRICT JSON only.` },
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
  // Best-effort parse
  const jsonText = typeof raw === 'string' ? raw : JSON.stringify(raw);
  let data = {};
  try{ data = JSON.parse(jsonText); }catch{ /* model might wrap in ```json */ 
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  }
  // minimal sanity
  return {
    summary: data.summary || 'Video analysis complete.',
    focus: Array.isArray(data.focus)?data.focus.slice(0,6):[],
    drills: Array.isArray(data.drills)?data.drills.slice(0,6):[],
    comps: Array.isArray(data.comps)?data.comps.slice(0,4):[]
  };
}

/** The worker job */
async function runAnalysisJob({ userId, public_id, videoUrl, duration }){
  const profile = db.profiles[userId] || {};
  const user    = findUserById(userId) || {};
  const age     = profile.age ?? user.age ?? null;
  const isYouth = age != null ? Number(age) < 18 : false;

  // 1) sample frames
  if (!CLOUD_NAME) throw new Error('CLOUD_NAME env is required for frame URLs');
  const frames = sampleFrameUrls({ public_id, duration, n: isYouth ? 8 : 12 });

  // 2) call OpenAI
  const context = {
    role: profile.position || 'Unknown',
    foot: profile.foot || 'Unknown',
    age, isYouth,
    height: profile.height || null,
    weight: profile.weight || null
  };
  const { summary, focus, drills, comps } = await analyzeWithOpenAI({ frames, context });

  // 3) save to Library
  if (!Array.isArray(db.analysesByUser[userId])) db.analysesByUser[userId] = [];
  const item = {
    id: uuidv4(),
    summary, focus, drills,
    comps, // tip: on frontend you can render player images via https://ui-avatars.com/api/?name=${encodeURIComponent(name)}
    video_url: videoUrl || null,
    public_id,
    frames,             // stored so UI can show thumbnails
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
