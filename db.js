/**
 * PostgreSQL Database Connection
 * 
 * Creates a connection pool for the Ball Knowledge database.
 * Uses DATABASE_URL or POSTGRES_URL from environment (Railway).
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  throw new Error('No database configuration found. Set DATABASE_URL or POSTGRES_URL.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

console.log('[PostgreSQL] Connected via DATABASE_URL');

// Error handler
pool.on('error', (err) => {
  console.error('[PostgreSQL] Connection error:', err.message);
});

export default pool;
