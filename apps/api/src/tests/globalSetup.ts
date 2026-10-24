import { resolve } from 'path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { ensureAppLogin } from '../db/appRole.js';
import { loadDemoData } from '../db/demo.js';
import { resolveTestDatabaseUrl, resolveTestMigrationUrl } from './testDatabaseUrl.js';

/**
 * Runs once before the API test suite: creates the test database if it does
 * not exist yet, applies all migrations and makes sure the API's user works
 * in it, all as the owner, so `npm test` needs no manual setup, with the
 * demo data. The tests then work as the API's user, under
 * row-level security (#13).
 */
export default async function setup(): Promise<void> {
  const testUrl = resolveTestMigrationUrl();
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

  await ensureAppLogin(testUrl, resolveTestDatabaseUrl());

  // The tests sell, order and buy the demo books, so the test database is a
  // shop with the demo data loaded, as `npm run db:demo` loads it; rows it
  // lacks (a database kept from before 1700000078) are added.
  const owner = new pg.Client({ connectionString: testUrl });
  await owner.connect();
  try {
    await loadDemoData(owner, 1, { missingOnly: true });
  } finally {
    await owner.end();
  }
}
