/**
 * PostgreSQL Database Connection
 * 
 * Creates a connection pool for the Ball Knowledge database.
 */

import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let pool;

// Check if running on Vercel with AWS IAM (has AWS_ROLE_ARN)
const isVercel = process.env.AWS_ROLE_ARN && process.env.PGHOST;

if (isVercel) {
  // Vercel: Use AWS IAM authentication
  const signer = new Signer({
    hostname: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    username: process.env.PGUSER || 'postgres',
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN,
      clientConfig: { region: process.env.AWS_REGION || 'us-east-1' },
    }),
  });

  pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER || 'postgres',
    database: process.env.PGDATABASE || 'postgres',
    password: () => signer.getAuthToken(),
    port: Number(process.env.PGPORT || 5432),
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  
  console.log('[PostgreSQL] Using AWS IAM authentication');
} else if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  // Railway/Local: Use connection string
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  console.log('[PostgreSQL] Using connection string');
} else {
  throw new Error('No database configuration found');
}

// Error handler
pool.on('error', (err) => {
  console.error('[PostgreSQL] Connection error:', err.message);
});

export default pool;
