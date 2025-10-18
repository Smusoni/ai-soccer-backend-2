import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Root route
app.get('/', (req, res) => {
  res.send('ai-soccer-backend is running ✅');
});

// Health route
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Railway port
const PORT = process.env.PORT || 8080;
// Simple in-memory player list
let players = [];

// Add a new player
app.post('/api/player', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
  players.push(name);
  res.json({ ok: true, message: `${name} added!`, players });
});

// Get all players
app.get('/api/players', (req, res) => {
  res.json({ ok: true, players });
});
// ---- Simple in-memory attributes store ----
// { "<playerNameLowercase>": { Speed: 50, Technique: 50, ... } }
const attrsByPlayer = {};

function blankAttrs() {
  return {
    Speed: 50,
    Technique: 50,
    Awareness: 50,
    "Work Rate": 50,
    "Decision-Making": 50,
    Composure: 50
  };
}

// Get a player's profile (name + attributes)
app.get('/api/player/:name', (req, res) => {
  const name = (req.params.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name required' });

  const key = name.toLowerCase();
  const attrs = attrsByPlayer[key] || blankAttrs();
  res.json({ ok: true, name, attributes: attrs });
});

// Upsert (save) attributes for a player
app.put('/api/player/:name/attributes', (req, res) => {
  const name = (req.params.name || '').trim();
  const incoming = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'Name required' });

  const key = name.toLowerCase();
  const current = attrsByPlayer[key] || blankAttrs();

  // Merge & clamp 0..100
  for (const k of Object.keys(current)) {
    const v = Number(incoming[k]);
    if (!Number.isNaN(v)) {
      current[k] = Math.max(0, Math.min(100, Math.round(v)));
    }
  }
  attrsByPlayer[key] = current;

  res.json({ ok: true, name, attributes: current });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
