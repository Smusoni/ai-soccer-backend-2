/**
 * Database Migration Script
 * 
 * Runs SQL migrations and optionally migrates data from JSON to PostgreSQL.
 * 
 * Usage:
 *   node migrate.js              - Run migrations only
 *   node migrate.js --with-data  - Run migrations and migrate existing data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  console.log('🚀 Starting database migrations...\n');
  
  try {
    // Read and execute schema
    const schemaPath = path.join(__dirname, 'migrations', '001_initial_schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    console.log('📝 Running schema migrations...');
    await pool.query(schema);
    console.log('✅ Schema migrations completed\n');
    
    // Check if we should migrate data
    const shouldMigrateData = process.argv.includes('--with-data');
    
    if (shouldMigrateData) {
      console.log('📦 Migrating existing data from JSON...');
      await migrateExistingData();
    }
    
    console.log('\n✨ All migrations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

async function migrateExistingData() {
  const dataPath = path.join(__dirname, 'data', 'data.json');
  
  if (!fs.existsSync(dataPath)) {
    console.log('⚠️  No existing data.json found, skipping data migration');
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  let userCount = 0;
  let analysisCount = 0;
  
  // Migrate users
  if (data.users) {
    for (const [userId, user] of Object.entries(data.users)) {
      try {
        await pool.query(
          'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [userId, user.email, user.password]
        );
        userCount++;
        
        // Migrate coordinator profile if exists
        if (data.coordinators && data.coordinators[userId]) {
          const coord = data.coordinators[userId];
          await pool.query(
            `INSERT INTO coordinator_profiles (user_id, coordinator_name, organization, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET
               coordinator_name = EXCLUDED.coordinator_name,
               organization = EXCLUDED.organization,
               role = EXCLUDED.role`,
            [userId, coord.coordinatorName, coord.organization, coord.role]
          );
        }
        
        // Migrate candidate profile if exists
        if (data.candidates && data.candidates[userId]) {
          const cand = data.candidates[userId];
          await pool.query(
            `INSERT INTO candidate_profiles (user_id, candidate_name, position, age, height, weight, foot, jersey_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id) DO UPDATE SET
               candidate_name = EXCLUDED.candidate_name,
               position = EXCLUDED.position,
               age = EXCLUDED.age,
               height = EXCLUDED.height,
               weight = EXCLUDED.weight,
               foot = EXCLUDED.foot,
               jersey_number = EXCLUDED.jersey_number`,
            [userId, cand.candidateName, cand.position, cand.age, cand.height, cand.weight, cand.foot, cand.jerseyNumber]
          );
        }
        
        // Migrate analyses
        if (data.analysesByUser && data.analysesByUser[userId]) {
          for (const analysis of data.analysesByUser[userId]) {
            await pool.query(
              `INSERT INTO analyses (id, user_id, video_type, video_url, candidate_name, position, analysis_data, highlights)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (id) DO NOTHING`,
              [
                analysis.id,
                userId,
                analysis.videoType,
                analysis.videoUrl,
                analysis.candidateName,
                analysis.position,
                JSON.stringify(analysis.analysis),
                JSON.stringify(analysis.highlights)
              ]
            );
            analysisCount++;
          }
        }
      } catch (err) {
        console.error(`Error migrating user ${userId}:`, err.message);
      }
    }
  }
  
  console.log(`✅ Migrated ${userCount} users and ${analysisCount} analyses`);
}

runMigrations();
