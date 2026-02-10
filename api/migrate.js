import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function handler(req, res) {
  // Simple security - only allow in development or with secret key
  const secret = req.query.secret || req.headers['x-migration-secret'];
  if (secret !== process.env.MIGRATION_SECRET && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    console.log('Starting database migration...');
    
    // Read the schema file
    const schemaPath = path.join(__dirname, '..', 'migrations', '001_initial_schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the schema
    await pool.query(schemaSql);
    console.log('Schema created successfully');
    
    res.json({ 
      ok: true, 
      message: 'Database migration completed successfully',
      tables: ['users', 'coordinator_profiles', 'candidate_profiles', 'analyses', 'analytics_events']
    });
  } catch (error) {
    console.error('Migration failed:', error);
    res.status(500).json({ 
      ok: false, 
      error: 'Migration failed', 
      detail: error.message 
    });
  }
}
