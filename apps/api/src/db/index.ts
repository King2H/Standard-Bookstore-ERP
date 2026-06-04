import { Pool } from 'pg';

// Pool is created lazily — DATABASE_URL is validated at first use, not at import time
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

db.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'Unexpected DB pool error', err: err.message }));
});

export async function checkDbConnection(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_URL environment variable is not set' }));
    return false;
  }
  try {
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}
