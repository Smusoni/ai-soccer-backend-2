import express from 'express';

const app = express();
const PORT = 3002;

app.get('/health', (req, res) => {
  res.json({ ok: true, test: 'working' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server running on ${PORT}`);
});

setInterval(() => {}, 1000000);
