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
const config = process.env.POSTGRES_URL 
  ? {
      connectionString: process.env.POSTGRES_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      database: process.env.PGDATABASE || 'postgres',
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

const pool = new Pool(config);

// Error handler
pool.on('error', (err) => {
  console.error('[PostgreSQL] Connection error:', err.message);
});

console.log('[PostgreSQL] Pool initialized');

export default pool;
