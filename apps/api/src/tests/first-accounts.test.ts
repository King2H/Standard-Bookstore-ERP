// #31 (owner decision 3a, 2026-11-06): an install made from the bundle sets
// the Super_Admin and Admin passwords the installer asks for. Before, every
// shop started with the public password Admin@1234 on both, open on the
// shop's network until someone changed it. Only an account still holding
// that seed password is set, so running the installer again never
// overwrites a password the shop chose.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { ownerDb, closeOwnerDb } from './helpers/ownerDb.js';
import { setInstallPasswords, SEED_PASSWORD } from '../db/firstAccounts.js';

const TENANT = 'First Accounts Tenant';
const SUPER = 'firstacct_super';
const ADMIN = 'firstacct_admin';

describe('The first accounts of an install (#31)', () => {
  let tenantId: number;
  const owner = () => ownerDb();
  const staffRow = async (username: string) =>
    (await owner().query(`SELECT id, password_hash, must_change_password, password_changed_at FROM staff WHERE username = $1`, [username])).rows[0];

  async function cleanUp() {
    const tenants = `SELECT id FROM tenants WHERE name = '${TENANT}'`;
    await owner().query(`DELETE FROM audit_logs WHERE tenant_id IN (${tenants})`);
    await owner().query(`DELETE FROM staff WHERE tenant_id IN (${tenants})`);
    await owner().query(`DELETE FROM tenants WHERE name = $1`, [TENANT]);
  }

  beforeAll(async () => {
    await cleanUp();
    tenantId = (await owner().query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT])).rows[0].id;
    const seeded = await bcrypt.hash(SEED_PASSWORD, 4);
    for (const [username, name] of [[SUPER, 'Shop Owner'], [ADMIN, 'Shop Admin']]) {
      await owner().query(
        `INSERT INTO staff (tenant_id, username, full_name, password_hash, must_change_password) VALUES ($1, $2, $3, $4, true)`,
        [tenantId, username, name, seeded],
      );
    }
  });

  afterAll(async () => { await cleanUp(); await closeOwnerDb(); });

  it('refuses a weak password and changes nothing', async () => {
    await expect(setInstallPasswords(owner(), tenantId, [{ username: SUPER, password: 'short' }])).rejects.toThrow(/at least 10 characters/);
    expect(await bcrypt.compare(SEED_PASSWORD, (await staffRow(SUPER)).password_hash)).toBe(true);
  });

  it('sets the chosen passwords, no change asked at first sign-in, and audits it (was: the public seed password)', async () => {
    const result = await setInstallPasswords(owner(), tenantId, [
      { username: SUPER, password: 'Owner#Choice2026' },
      { username: ADMIN, password: 'Admin#Choice2026' },
    ]);
    expect(result).toEqual([{ username: SUPER, set: true }, { username: ADMIN, set: true }]);
    const s = await staffRow(SUPER);
    expect(await bcrypt.compare('Owner#Choice2026', s.password_hash)).toBe(true);
    expect([s.must_change_password, s.password_changed_at !== null]).toEqual([false, true]);
    expect(await bcrypt.compare('Admin#Choice2026', (await staffRow(ADMIN)).password_hash)).toBe(true);
    const audit = await owner().query(
      `SELECT meta->>'action' AS action FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'staff' AND entity_id = $2`, [tenantId, String(s.id)],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['password_set_at_install']);
  });

  it('never overwrites a password already chosen when run again', async () => {
    const before = (await staffRow(SUPER)).password_hash;
    expect(await setInstallPasswords(owner(), tenantId, [{ username: SUPER, password: 'Other#Choice2026' }])).toEqual([{ username: SUPER, set: false }]);
    expect((await staffRow(SUPER)).password_hash).toBe(before);
  });
});
