import { ensureAppLogin } from '../src/db/appRole.js';

// npm run db:app-role: creates or updates the API's database login user
// (DATABASE_URL) as a member of bms_app, using the owner's connection.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error('Set DATABASE_URL (the API user) and MIGRATION_DATABASE_URL (the owner) in .env: see docs/development.md');
  process.exit(1);
}
await ensureAppLogin(ownerUrl, appUrl);
console.log(`Database user "${decodeURIComponent(new URL(appUrl).username)}" works as bms_app.`);
