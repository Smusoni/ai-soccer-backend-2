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

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
