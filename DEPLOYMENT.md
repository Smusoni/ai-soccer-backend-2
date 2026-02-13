# Ball Knowledge Deployment Guide

Quick start for evaluators, investors, and judges.

## 1-Minute Setup

```bash
# Clone and install
git clone <repo>
cd ai-soccer-backend-2-1
npm install

# Set up environment (copy from .env.example)
cp .env.example .env
# Edit .env and add your API keys

# Start server
npm start

# Server runs on http://localhost:3001
```

## Environment Variables

Create `.env` file with:

```
# Required
OPENAI_API_KEY=sk-your-key-here
JWT_SECRET=your-secret-key-min-32-chars

# Optional
PORT=3001
NODE_ENV=development
APP_ORIGINS=http://localhost:3000,http://localhost:3001
```

### Getting API Keys

1. **OpenAI API Key**
   - Visit: https://platform.openai.com/api/keys
   - Create new secret key
   - Paste into .env

2. **Cloudinary (Video Hosting)**
   - Sign up: https://cloudinary.com
   - Get Cloud Name from Dashboard
   - Already integrated (no key needed for basic frame extraction)

## Testing the API

### Health Check
```bash
curl http://localhost:3001/api/health
# Response: {"status":"ok"}
```

### Test OpenAI Connection
```bash
curl -X POST http://localhost:3001/api/test-openai
# Response: {"status":"ok","model":"gpt-4o","message":"API connected"}
```

### Full End-to-End Flow

#### 1. Sign Up
```bash
curl -X POST http://localhost:3001/api/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "coordinator@club.com",
    "password": "test123"
  }'
# Response: {"message":"User created","userId":"...","token":"eyJ..."}
```

#### 2. Create Coordinator Profile
```bash
curl -X POST http://localhost:3001/api/coordinator \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Smith",
    "organization": "Manchester FC",
    "role": "Head Scout"
  }'
```

#### 3. Set Candidate Profile
```bash
curl -X POST http://localhost:3001/api/candidate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alex Johnson",
    "position": "Midfielder",
    "age": 22,
    "height": "5ft 10in",
    "weight": "160 lbs",
    "foot": "right",
    "jerseyNumber": 10
  }'
```

#### 4. Analyze Game Video
```bash
curl -X POST http://localhost:3001/api/analyze \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrl": "https://cloudinary-video-link.mp4",
    "videoType": "game",
    "duration": 45
  }'
```

Response includes:
- `analysis.passMetrics` - pass completion %
- `analysis.firstTouchAnalysis` - grade 1-10
- `analysis.gameAwareness` - positioning, decision quality
- `analysis.defensiveActions` - tackles, interceptions
- `highlights` - 3-5 auto-extracted moments with timestamps

## Architecture

### Backend Stack
- **Runtime**: Node.js v20+
- **Framework**: Express.js
- **AI**: OpenAI GPT-4o (vision) + GPT-4o-mini (highlights)
- **Video**: Cloudinary frame extraction
- **Auth**: JWT tokens
- **Database**: JSON file (development) → PostgreSQL (production)

### Video Processing Pipeline

```
Video Upload (Cloudinary URL)
    ↓
Extract 10 frames at timestamps: 0.1, 0.2, 0.3... 1.0
    ↓
Cloudinary transformation: so_{timestamp},w_800,q_80,f_jpg
    ↓
Send frames to GPT-4o vision with analysis prompt
    ↓
Receive quantified metrics (JSON)
    ↓
Send frames to GPT-4o-mini for highlights
    ↓
Return analysis + highlights (90 seconds total)
```

### Database Schema

```json
{
  "users": [
    {
      "id": "user-123",
      "email": "coordinator@club.com",
      "password": "hashed-bcrypt",
      "createdAt": "2024-01-15T10:00:00Z"
    }
  ],
  "coordinators": [
    {
      "userId": "user-123",
      "name": "John Smith",
      "organization": "Manchester FC",
      "role": "Head Scout"
    }
  ],
  "candidates": [
    {
      "userId": "user-123",
      "name": "Alex Johnson",
      "position": "Midfielder",
      "age": 22,
      "height": "5ft 10in",
      "weight": "160 lbs",
      "foot": "right",
      "jerseyNumber": 10
    }
  ],
  "analysesByUser": [
    {
      "id": "analysis-456",
      "userId": "user-123",
      "candidateName": "Alex Johnson",
      "videoType": "game",
      "analysis": { /* full game/training metrics */ },
      "highlights": [ /* 3-5 key moments */ ],
      "createdAt": "2024-01-15T10:15:00Z"
    }
  ]
}
```

## Production Deployment

### Heroku (Recommended for Quick Demo)

```bash
# Install Heroku CLI
# heroku login

git push heroku main

# Set environment variables on Heroku
heroku config:set OPENAI_API_KEY=sk-...
heroku config:set JWT_SECRET=...
heroku config:set NODE_ENV=production

# View logs
heroku logs --tail
```

### AWS / DigitalOcean

```bash
# Use PM2 process manager
npm install -g pm2

pm2 start server.js --name "ball-knowledge-api"
pm2 save
pm2 startup

# Monitor
pm2 monit
```

### Production Checklist

- [ ] Move to PostgreSQL database
- [ ] Set `NODE_ENV=production`
- [ ] Enable HTTPS (SSL certificate)
- [ ] Set up CORS for your frontend domain
- [ ] Configure rate limiting
- [ ] Add error logging (Sentry, LogRocket)
- [ ] Set up automated backups
- [ ] Monitor API usage and costs

## Performance Tuning

### Current Bottlenecks

1. **GPT-4o vision calls** (~30-40 seconds per analysis)
   - Solution: Queue system for batch processing
   - Solution: Caching similar analyses

2. **Frame extraction** (~5-10 seconds)
   - Solution: Pre-cache Cloudinary transforms
   - Solution: Parallel frame processing

### Optimization Roadmap

```
Phase 1: Add Redis caching
Phase 2: Implement async job queue (Bull.js)
Phase 3: Multi-region deployment
Phase 4: ML fine-tuning on soccer-specific metrics
```

## Common Issues & Fixes

### Issue: "OPENAI_API_KEY not found"
```bash
# Solution: Check .env file exists and has correct key
cat .env | grep OPENAI_API_KEY
```

### Issue: "Port 3001 already in use"
```bash
# Solution: Kill existing process
lsof -i :3001
kill -9 <PID>
# Or use different port
PORT=3002 npm start
```

### Issue: "Invalid video URL"
```bash
# Solution: Ensure video is hosted on Cloudinary
# Check URL format: https://res.cloudinary.com/{cloud}/video/upload/...
```

### Issue: "Analysis returns null"
```bash
# Solution: Check OpenAI API quota
# Solution: Verify video duration > 10 seconds
# Solution: Check Cloudinary frame extraction URLs manually
```

## Monitoring & Analytics

### Key Metrics to Track

```javascript
// In production, add logging:
- API response times
- Analysis success rate
- GPT-4o API costs per analysis
- User retention rate
- Average analysis quality score
- Error rates by endpoint
```

### Recommended Tools

- **Monitoring**: Datadog, New Relic, Sentry
- **Logs**: LogRocket, Papertrail
- **Analytics**: Segment, PostHog
- **Billing**: OpenAI usage dashboard

## Support

For issues or questions:
1. Check this deployment guide
2. Review [PITCH.md](PITCH.md) for business context
3. Check [README.md](README.md) for API documentation

---

**Deploy and demo Ball Knowledge in 5 minutes.** ✨
