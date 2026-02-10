/**
 * PostgreSQL Database Connection
 * 
 * Creates a connection pool for the Ball Knowledge database.
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Use connection string if available, otherwise use individual env vars
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  host: !process.env.POSTGRES_URL ? process.env.PGHOST : undefined,
  port: !process.env.POSTGRES_URL ? Number(process.env.PGPORT) : undefined,
  database: !process.env.POSTGRES_URL ? (process.env.PGDATABASE || 'postgres') : undefined,
  user: !process.env.POSTGRES_URL ? process.env.PGUSER : undefined,
  password: !process.env.POSTGRES_URL ? process.env.PGPASSWORD : undefined,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Error handler
pool.on('error', (err) => {
  console.error('[PostgreSQL] Connection error:', err.message);
});

console.log('[PostgreSQL] Pool initialized');

export default pool;
