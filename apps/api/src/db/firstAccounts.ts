import bcrypt from 'bcrypt';
import type pg from 'pg';
import { PasswordSchema } from '@bms/shared';

/** The password the first accounts are seeded with by the migrations: public, in the repository. */
export const SEED_PASSWORD = 'Admin@1234';
const BCRYPT_ROUNDS = 12;

/**
 * Sets the passwords the installer asks for on a new install's first
 * accounts (#31, owner decision 3a), instead of the public seed password and
 * a change at first sign-in. Run with the owner's connection, which
 * row-level security does not apply to. Only an account still holding the
 * seed password is set: running the installer again never overwrites a
 * password the shop chose. Each change is audited in the tenant.
 */
export async function setInstallPasswords(
  owner: pg.Pool | pg.ClientBase,
  tenantId: number,
  accounts: Array<{ username: string; password: string }>,
): Promise<Array<{ username: string; set: boolean }>> {
  for (const a of accounts) {
    const checked = PasswordSchema.safeParse(a.password);
    if (!checked.success) throw new Error(`${a.username}: ${checked.error.issues[0].message}`);
  }
  const result: Array<{ username: string; set: boolean }> = [];
  for (const a of accounts) {
    const row = (await owner.query<{ id: number; password_hash: string }>(
      `SELECT id, password_hash FROM staff WHERE tenant_id = $1 AND username = $2`, [tenantId, a.username],
    )).rows[0];
    if (!row) throw new Error(`${a.username}: no such account`);
    if (!(await bcrypt.compare(SEED_PASSWORD, row.password_hash))) {
      result.push({ username: a.username, set: false });
      continue;
    }
    const hash = await bcrypt.hash(a.password, BCRYPT_ROUNDS);
    await owner.query(
      `UPDATE staff SET password_hash = $1, must_change_password = false, password_changed_at = now() WHERE id = $2 AND tenant_id = $3`,
      [hash, row.id, tenantId],
    );
    await owner.query(
      `INSERT INTO audit_logs (tenant_id, staff_id, action, entity_type, entity_id, meta) VALUES ($1, NULL, 'UPDATE', 'staff', $2, $3)`,
      [tenantId, String(row.id), JSON.stringify({ action: 'password_set_at_install' })],
    );
    result.push({ username: a.username, set: true });
  }
  return result;
}
