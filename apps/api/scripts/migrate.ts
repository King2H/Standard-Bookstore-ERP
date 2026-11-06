import { runner } from 'node-pg-migrate';
import { ensureAppLogin } from '../src/db/appRole.js';

// The install's migration step (#31, owner decision 4a): run once before the
// API starts, not by the API itself. Applies the migrations as the database
// owner, then makes sure the API's own user works (as npm run db:app-role).
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error('Set MIGRATION_DATABASE_URL (the owner) and DATABASE_URL (the API user)');
  process.exit(1);
}

const applied = await runner({
  databaseUrl: ownerUrl,
  dir: process.env.MIGRATIONS_DIR ?? 'migrations',
  migrationsTable: 'pgmigrations',
  direction: 'up',
  count: Infinity,
  log: (msg: string) => console.log(msg),
});
console.log(`Migrations applied: ${applied.length}.`);
await ensureAppLogin(ownerUrl, appUrl);
console.log('The API\'s database user works.');
