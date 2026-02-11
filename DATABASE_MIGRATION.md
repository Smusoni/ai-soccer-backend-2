# Database Migration - Updated Files

## Files Created/Updated

### 1. ✅ db.js (UPDATED)
**Changes:**
- Removed individual env var configuration (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
- Now uses single `POSTGRES_URL` connection string
- Added SSL configuration for AWS Aurora
- Improved error handling with process.exit on connection failure
- Added immediate connection test with SELECT NOW()

**Configuration:**
```javascript
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: process.env.POSTGRES_URL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
```

### 2. ✅ .env (UPDATED)
**Changes:**
- Added `POSTGRES_URL` connection string

**New environment variable:**
```env
POSTGRES_URL=postgres://postgres:Sydthekid10!@aws-apg-green-notebook.cluster-cgdyieucsxlg.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=require
```

### 3. ✅ server-new.js (CREATED)
**Complete rewrite with PostgreSQL integration**

**Major changes:**
- ❌ Removed: fs module, JSON file operations (loadDB, saveDB, ensureDataDir)
- ❌ Removed: db object with users/coordinators/candidates/analysesByUser
- ❌ Removed: DATA_DIR and DATA_PATH constants
- ❌ Removed: Analytics cache (now queries PostgreSQL directly)
- ✅ Added: `import pool from './db.js'`
- ✅ Added: Async database helper functions (findUser, findUserById)
- ✅ Converted: All endpoints to use async/await with PostgreSQL queries

**Endpoints updated to PostgreSQL:**

**Auth Endpoints:**
- `POST /api/signup` - INSERT INTO users
- `POST /api/login` - SELECT FROM users + bcrypt compare
- `GET /api/me` - SELECT FROM users

**Profile Endpoints:**
- `POST /api/coordinator` - INSERT/UPDATE coordinator_profiles
- `GET /api/coordinator` - SELECT FROM coordinator_profiles
- `POST /api/candidate` - INSERT/UPDATE candidate_profiles
- `GET /api/candidate` - SELECT FROM candidate_profiles
- `GET /api/profile` - SELECT user + coordinator + candidate
- `POST /api/profile` - INSERT/UPDATE coordinator + candidate

**Analysis Endpoints:**
- `POST /api/analyze` - INSERT INTO analyses (with JSON.stringify for analysis_data and highlights)
- `GET /api/analyses` - SELECT FROM analyses WHERE user_id (with ORDER BY created_at DESC)
- `GET /api/analyses/:id` - SELECT FROM analyses WHERE id AND user_id
- `DELETE /api/analyses/:id` - DELETE FROM analyses WHERE id AND user_id

**Analytics Endpoints:**
- `GET /api/analytics/dashboard` - Real-time queries for total users, analyses, daily active users, weekly trend
- `GET /api/analytics/user` - Real-time queries for user stats, skill distribution, average grade
- `POST /api/analytics/event` - INSERT INTO analytics_events
- `GET /api/analytics/engagement` - SELECT position distribution, top candidates

**All analysis functions remain the same:**
- extractFramesFromVideo()
- analyzeGameMetrics()
- analyzeTraining()
- extractHighlights()

## Next Steps

### Step 1: Backup Current server.js
```powershell
Copy-Item server.js server-old.js
```

### Step 2: Replace server.js with new version
```powershell
Copy-Item server-new.js server.js -Force
```

### Step 3: Run database migration (creates tables and imports data)
```powershell
node migrate.js --with-data
```

**Expected output:**
```
✅ PostgreSQL connected successfully
✅ Database connection verified
✅ Migration completed successfully
✅ Migrated 1 users
✅ Migrated 2 analyses
```

### Step 4: Test locally
```powershell
npm start
```

**Check in browser:**
- http://localhost:3001/api/health (should show `"database": "PostgreSQL"`)
- Login to your account
- Check library - should show your 2 coaching reports (Gee and Sweeny)

### Step 5: Deploy to Vercel

**Add environment variables in Vercel dashboard:**
1. Go to https://vercel.com/smusoni/ai-soccer-backend-2-1/settings/environment-variables
2. Add the following:

```
POSTGRES_URL=postgres://postgres:Sydthekid10!@aws-apg-green-notebook.cluster-cgdyieucsxlg.us-east-1.rds.amazonaws.com:5432/postgres?sslmode=require
JWT_SECRET=supersecretlocaldevkey123
OPENAI_API_KEY=(your existing key)
APP_ORIGINS=https://smusoni.github.io,http://localhost:8080
```

3. Deploy:
```powershell
git add .
git commit -m "Migrate to PostgreSQL (AWS Aurora)"
git push origin main
```

## Database Schema

Your PostgreSQL database has 5 tables:

1. **users** (id, email, password_hash, created_at, updated_at)
2. **coordinator_profiles** (user_id FK, coordinator_name, organization, role, updated_at)
3. **candidate_profiles** (user_id FK, candidate_name, position, age, height, weight, foot, jersey_number, updated_at)
4. **analyses** (id, user_id FK, video_type, video_url, candidate_name, position, analysis_data JSONB, highlights JSONB, created_at)
5. **analytics_events** (id, user_id FK, event_type, event_data JSONB, created_at)

## Data Migration

Your existing data will be migrated:
- ✅ 1 user (Sydney Musoni, sydnyjr@gmail.com)
- ✅ 2 coaching reports:
  - Gee (Midfielder, dribbling training)
  - Sweeny (Midfielder, close control training)

## Benefits of PostgreSQL Migration

1. **✅ Persistent Storage** - Data survives Vercel redeployments (no more /tmp data loss)
2. **✅ Scalability** - AWS Aurora can handle thousands of concurrent users
3. **✅ Data Integrity** - Foreign keys, constraints, transactions
4. **✅ Better Queries** - Efficient JOINs, indexes, aggregations
5. **✅ Real-time Analytics** - No more cache staleness, always accurate stats
6. **✅ Production Ready** - Industry-standard relational database

## Troubleshooting

### Connection errors:
- Verify POSTGRES_URL is correct in .env
- Check AWS Aurora security group allows your IP
- Ensure SSL is enabled in AWS Aurora settings

### Migration errors:
- If tables already exist, drop them first: `DROP TABLE IF EXISTS analytics_events, analyses, candidate_profiles, coordinator_profiles, users CASCADE;`
- Run migration again: `node migrate.js --with-data`

### Missing data after migration:
- Check local data/data.json exists before running migration
- Verify migration script ran with --with-data flag
- Query database: `SELECT * FROM users;` and `SELECT * FROM analyses;`

## Files Summary

| File | Status | Purpose |
|------|--------|---------|
| db.js | ✅ Updated | PostgreSQL connection with POSTGRES_URL |
| .env | ✅ Updated | Added POSTGRES_URL connection string |
| server-new.js | ✅ Created | Complete PostgreSQL implementation |
| server.js | ⏳ To replace | Current JSON-based version |
| migrate.js | ✅ Ready | Database schema + data migration script |
| 001_initial_schema.sql | ✅ Ready | PostgreSQL table definitions |

---

**Status: All code files created and ready for migration!**

Run the next steps above to complete the migration to AWS Aurora PostgreSQL.
