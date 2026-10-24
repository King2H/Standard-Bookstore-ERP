import pg from 'pg';
import { loadDemoData } from '../src/db/demo.js';

// npm run db:demo: loads the demo books, suppliers and customers into an empty
// shop (the default tenant), as the database owner (MIGRATION_DATABASE_URL).
// A fresh install has no demo data; this is for trying the system out.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('Set MIGRATION_DATABASE_URL (the database owner) in .env: see docs/development.md');
  process.exit(1);
}

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  const loaded = await loadDemoData(client);
  console.log(`Demo data loaded: ${loaded.books} books, ${loaded.suppliers} suppliers, ${loaded.customers} customers.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
