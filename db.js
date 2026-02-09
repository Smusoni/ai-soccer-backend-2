/**
 * PostgreSQL Database Connection
 * 
 * Creates a connection pool for the Ball Knowledge database.
 * Uses POSTGRES_URL connection string from environment.
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Use POSTGRES_URL connection string (AWS Aurora PostgreSQL)
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: process.env.POSTGRES_URL ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test connection on startup
pool.on('connect', () => {
  console.log('[PostgreSQL] Connected successfully');
});

pool.on('error', (err) => {
  console.error('[PostgreSQL] Connection error:', err.message);
  // Don't exit in serverless environment - let individual queries handle errors
});

export default pool;
