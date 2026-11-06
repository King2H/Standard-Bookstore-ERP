import pg from 'pg';
import { setInstallPasswords } from '../src/db/firstAccounts.js';

// Run by the installer once the database is migrated (#31, owner decision 3a):
// sets the shop's Super_Admin and Admin passwords, given in the environment
// for this one run, on the install's first tenant. Accounts whose password was
// already chosen are left as they are.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const superAdmin = process.env.BMS_SUPERADMIN_PASSWORD;
const admin = process.env.BMS_ADMIN_PASSWORD;
if (!ownerUrl || !superAdmin || !admin) {
  console.error('Set MIGRATION_DATABASE_URL, BMS_SUPERADMIN_PASSWORD and BMS_ADMIN_PASSWORD');
  process.exit(1);
}

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
try {
  const tenant = (await owner.query<{ id: number }>('SELECT min(id) AS id FROM tenants')).rows[0].id;
  const result = await setInstallPasswords(owner, tenant, [
    { username: 'superadmin', password: superAdmin },
    { username: 'admin', password: admin },
  ]);
  for (const r of result) console.log(`${r.username}: ${r.set ? 'password set' : 'password already chosen, left as it is'}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await owner.end();
}
