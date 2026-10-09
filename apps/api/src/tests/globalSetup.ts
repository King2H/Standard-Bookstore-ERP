import { resolve } from 'path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { resolveTestDatabaseUrl } from './testDatabaseUrl.js';

/**
 * Runs once before the API test suite: creates the test database if it does
 * not exist yet and applies all migrations, so `npm test` needs no manual setup.
 */
export default async function setup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();
  const dbName = decodeURIComponent(new URL(testUrl).pathname.slice(1));

  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)}`);
    }
  } finally {
    await admin.end();
  }

  // Migrations that encrypt data (1700000052) need the key the tests use;
  // vitest.config.ts gives the workers the same default.
  process.env.COLUMN_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000001';

  await runner({
    databaseUrl: testUrl,
    dir: resolve(__dirname, '../db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });
}
