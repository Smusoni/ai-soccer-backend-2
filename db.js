/**
 * PostgreSQL Database Connection
 * 
 * Creates a connection pool for the Ball Knowledge database.
 * Uses AWS IAM authentication for Vercel deployment.
 */

import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import { attachDatabasePool } from '@vercel/functions';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let pool;

// Check if running on Vercel (has AWS_ROLE_ARN)
if (process.env.AWS_ROLE_ARN) {
  // Vercel production: Use AWS IAM authentication
  const signer = new Signer({
    hostname: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    username: process.env.PGUSER,
    region: process.env.AWS_REGION,
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN,
      clientConfig: { region: process.env.AWS_REGION },
    }),
  });

  pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE || 'postgres',
    password: () => signer.getAuthToken(),
    port: Number(process.env.PGPORT),
    ssl: { rejectUnauthorized: false },
  });
  
  attachDatabasePool(pool);
  console.log('[PostgreSQL] Connected with AWS IAM authentication');
} else {
  // Local development: Use POSTGRES_URL connection string
  pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: process.env.POSTGRES_URL ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  console.log('[PostgreSQL] Connected with connection string');
}

// Error handler
pool.on('error', (err) => {
  console.error('[PostgreSQL] Connection error:', err.message);
});

export default pool;
