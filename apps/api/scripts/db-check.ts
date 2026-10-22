import pg from 'pg';
import { exitCode, formatReport, runChecks } from '../src/db/checks/run.js';

// npm run db:check: reports data that breaks the consistency rules (#165),
// in every tenant, as the database owner (MIGRATION_DATABASE_URL). Read-only:
// it changes nothing. Exits with 1 when an error-level rule is broken.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('Set MIGRATION_DATABASE_URL (the database owner) in .env: see docs/development.md');
  process.exit(1);
}

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const findings = await runChecks(client);
  await client.query('ROLLBACK');
  console.log(`Data consistency check: ${new URL(ownerUrl).pathname.slice(1)}`);
  console.log(formatReport(findings));
  process.exitCode = exitCode(findings);
} finally {
  await client.end();
}
