# SOTA: AI-Powered Soccer Video Analysis Platform

*For Y Combinator*

## The Problem

Soccer scouts and coordinators spend **30+ hours per candidate** manually reviewing game and training videos. Result: talent decisions based on **intuition, not data**.

Current solutions:
- **Too expensive**: $5,000-15,000/month (only for elite clubs)
- **Too slow**: 30+ minutes per video analysis
- **Too generic**: Don't differentiate game vs. training performance
- **Too incomplete**: Missing quantified metrics coaches actually use

**Market reality**: 1,200+ professional clubs globally, 10,000+ scouts with no affordable solution for AI-assisted talent evaluation.

## The Solution

**SOTA** delivers AI-powered candidate evaluation in 90 seconds, with quantified metrics that replace hours of manual work.

One coordinator. One candidate. Deep dive analysis with GPT-4o vision.

### Key Features

#### Dual Analysis Modes
- **Game Footage Analysis**: Evaluates competitive performance with quantified metrics
- **Training Footage Analysis**: Assesses technical execution and consistency

#### Game Metrics (AI-Generated)
- Pass completion % (total passes, completed, success rate)
- First touch quality (1-10 grade)
- Game awareness (positioning, scanning, decision quality)
- Defensive actions (tackles, interceptions, success %)
- Critical moments (auto-identified key plays with timestamps)
- Alternative decisions (what could have been better)
- Overall performance grade (1-10)

#### Training Metrics (AI-Generated)
- Session focus detection (passing, dribbling, shooting, etc.)
- Technical execution (1-10 grade)
- Movement quality breakdown (speed, fluidity, balance, athleticism)
- Decision-making grade (1-10)
- Consistency scoring (1-10)
- Recommended drills for improvement
- Areas to improve (auto-detected weaknesses)

#### AI Highlights
- Automatically extracts 3-5 best moments from video
- Timestamps normalized for quick review
- Categorized by play type (pass, dribble, shot, defense, awareness)
- Video timestamps enable instant playback to key moments

## Product Workflow

1. **Coordinator signs up** with name, organization, role
2. **Sets candidate profile** (name, position, age, height, weight, foot, jersey number)
3. **Uploads game or training video** via Cloudinary
4. **AI analyzes** in real-time with GPT-4o vision processing (10 frames extracted)
5. **Gets full report** with quantified metrics, grades, highlights, and recommendations
6. **Stores in library** for future reference and comparison

## Technical Stack

**Backend:**
- Node.js + Express.js
- OpenAI GPT-4o (vision) + GPT-4o-mini (highlights)
- Cloudinary (video hosting + frame extraction)
- JWT authentication (90-day tokens)
- JSON file-based persistence (scales to SQLite/PostgreSQL)

**Frontend:**
- Vanilla JavaScript
- HTML/CSS responsive design
- Dark theme with accent colors (#00ff95, #19d3ff)
- Modal-based navigation

**Infrastructure:**
- Express CORS-enabled
- Video frame extraction at 10 timestamps
- Async analysis with error fallbacks

## API Endpoints

### Authentication
- `POST /api/signup` - Register coordinator
- `POST /api/login` - Login coordinator
- `GET /api/me` - Get current user

### Profiles
- `POST /api/coordinator` - Create coordinator profile
- `GET /api/coordinator` - Retrieve coordinator profile
- `POST /api/candidate` - Create/update candidate profile
- `GET /api/candidate` - Get candidate profile

### Analysis (Core Feature)
- `POST /api/analyze` - Analyze video (game or training)
  - Request: `{ videoUrl, videoType: "game"|"training", duration }`
  - Response: `{ analysis, highlights, candidateName, position }`

### Library
- `GET /api/analyses` - List all analyses
- `GET /api/analyses/:id` - Get specific analysis
- `DELETE /api/analyses/:id` - Delete analysis

## Getting Started

### Prerequisites
- Node.js v20+
- npm
- OpenAI API key
- Cloudinary account (for video hosting)

### Installation

```bash
git clone <repo-url>
cd ai-soccer-backend-2-1
npm install
```

### Environment Variables

Create `.env`:
```
OPENAI_API_KEY=sk-...
JWT_SECRET=your-secret-key
PORT=3001
APP_ORIGINS=https://yourdomain.com,http://localhost:3000
```

### Running Locally

```bash
npm start
# Server runs on http://localhost:3001
```

### Testing

```bash
# Test health endpoint
curl http://localhost:3001/api/health

# Test OpenAI connection
curl -X POST http://localhost:3001/api/test-openai
```

## Data Flow

```
Video Upload (Cloudinary)
    ↓
Frame Extraction (10 frames at timestamps 0.1-1.0)
    ↓
GPT-4o Vision Analysis (quantified metrics)
    ↓
GPT-4o-mini Highlight Detection (best moments)
    ↓
Structured JSON Response (grades, stats, recommendations)
    ↓
Stored in Coordinator's Library
```

## Use Cases

1. **Scout Evaluations**: Assess candidate players before in-person trials
2. **Recruitment Decisions**: Compare multiple candidates with consistent metrics
3. **Training Analysis**: Identify technical weaknesses from training sessions
4. **Performance Tracking**: Monitor improvement over time with comparable metrics
5. **Team Selection**: Make data-driven decisions on squad composition

## Business Model

### Revenue Streams

#### Subscription (Primary)
| Tier | Price | Analyses/Month | Coordinators | Target |
|------|-------|---|---|---|
| **Starter** | $99 | 20 | 1 | Academies |
| **Pro** | $299 | Unlimited | 5 | Semi-pro clubs |
| **Enterprise** | $2,999+ | Unlimited | Unlimited | Professional clubs |

#### Per-Analysis (Secondary)
- $5-15 per analysis for trial users
- $0.10 cost to SOTA per analysis (95% margin)

### Unit Economics

- **CAC**: $50 (organic + partnership channels)
- **Monthly Subscription**: $99-299
- **Retention**: 90% (sticky product, daily use)
- **LTV (12-month)**: $1,079-$3,228
- **LTV/CAC Ratio**: 21-65x
- **Payback Period**: 1.5-2 months
- **Gross Margin**: 85-90%

### 18-Month Traction Goals

| Milestone | Timeline | Impact |
|-----------|----------|--------|
| 10 pilot customers | Month 3 | Proof of PMF |
| 50 paying customers | Month 12 | $15K MRR |
| 200 paying customers | Month 18 | $60K MRR |
| Series A ready | Month 18 | Raise $2-5M |

## Market Opportunity

- **TAM**: $500M (global soccer talent development market)
- **SAM**: $50M (coordinator/scout subscriptions)
- **SOM (Year 1)**: $2M (50 customers @ $300 avg/month)
- **1,200+ professional clubs** × $299/month average
- **50,000+ youth academies** × $99/month average
- **100,000+ semi-pro clubs** globally (underserved)

### Why This Market Is Winnable

1. **Post-Moneyball mindset** spreading globally (data-driven sports)
2. **GPT-4o vision** just became capable enough for sports analysis
3. **Soccer tech boom** ($billions in recent investment)
4. **Price sensitivity**: Market WANTS affordable alternative to $5K-15K/month tools
5. **First-mover advantage**: No existing AI-native competitor in this space

## Competitive Advantages

1. **AI-First Architecture**: Only platform using GPT-4o vision for detailed sports analysis
2. **Dual Analysis Mode**: Game + Training in one seamless workflow
3. **10x Cheaper**: $99-299/month vs. $5,000-15,000/month incumbents
4. **90-Second Analysis**: Faster than 30-60 minute manual review
5. **Actionable Output**: Specific recommendations + grades, not generic reports
6. **Domain Expertise**: Metrics designed by soccer professionals, not generic video AI
7. **Network Effects**: Early customers → case studies → partnership channels → scale

## 18-Month Roadmap (Post-YC)

### Month 1-3: Pilot & Product-Market Fit
- Launch with 10 pilot customers
- Gather feedback on metrics relevance
- Refine game/training analysis prompts
- Document case studies

### Month 4-8: Partnerships & Scale
- White-label integration with club management software
- Partnerships with recruiting platforms (Team Genius, etc.)
- European expansion (UK, Germany, France markets)
- Team analysis features (squad-wide patterns)

### Month 9-18: Product Expansion & International Scale
- Coaching dashboards (team performance analytics)
- Comparison reports (candidate vs. candidate benchmarks)
- Injury risk prediction
- Latin America expansion
- API marketplace for third-party integrations

### Year 2+: Enterprise Platform
- Position-specific analysis (defender vs. midfielder metrics)
- Real-time scouting during live matches
- Integration with major club management systems
- International player database + benchmarks

## Deployment

### Production Setup

```bash
# Use PostgreSQL for production
# Update database connection in server.js

# Set environment variables
export OPENAI_API_KEY=sk-...
export JWT_SECRET=production-secret
export PORT=3001
export NODE_ENV=production

# Start with process manager (PM2)
pm2 start server.js --name "sota-api"
```

### Scaling Considerations

- Async analysis queue for high volume
- Redis for caching frequent queries
- CDN for video distribution
- API rate limiting
- Usage-based billing integration

## License

MIT

## Contact

For inquiries or partnerships, contact: [contact info]

---

**Ready for Y Combinator S2026 batch** ✨
