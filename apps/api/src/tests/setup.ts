import 'dotenv/config';
import { afterAll } from 'vitest';

// Ensure test DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://bms:bms@localhost:5433/bms';
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test_jwt_secret_not_for_production';
}

// 64-char hex dev key for column encryption in tests
if (!process.env.COLUMN_ENCRYPTION_KEY) {
  process.env.COLUMN_ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
}

// Each test file gets a fresh module graph and therefore its own pg Pool.
// Close it when the file finishes; otherwise idle pools from earlier files
// pile up and the suite exceeds PostgreSQL's default max_connections (100).
afterAll(async () => {
  const { db } = await import('../db/index.js');
  await db.end();
});
