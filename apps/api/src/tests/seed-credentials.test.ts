import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../db/index.js';
import { ensureSeedData, DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

/**
 * ensureSeedData() runs on every server start. It must never overwrite data
 * an operator has changed — it previously reset the superadmin/admin
 * passwords to the published default and reactivated them on every restart.
 */
describe('ensureSeedData — does not overwrite operator changes on restart', () => {
  let original: Array<Record<string, unknown>> = [];
  let originalBranch: Record<string, unknown>;

  beforeAll(async () => {
    await ensureSeedData();
    original = (await db.query(
      `SELECT id, password_hash, is_active, must_change_password FROM staff WHERE id IN (1, 2) ORDER BY id`,
    )).rows;
    originalBranch = (await db.query(`SELECT name, is_active FROM branches WHERE id = 1`)).rows[0];
  });

  afterAll(async () => {
    for (const r of original) {
      await db.query(
        `UPDATE staff SET password_hash = $1, is_active = $2, must_change_password = $3 WHERE id = $4`,
        [r.password_hash, r.is_active, r.must_change_password, r.id],
      );
    }
    await db.query(`UPDATE branches SET name = $1, is_active = $2 WHERE id = 1`, [
      originalBranch.name, originalBranch.is_active,
    ]);
  });

  it('keeps a changed admin password and leaves must_change_password off', async () => {
    const changedHash = '$2b$10$changedchangedchangedchOchangedchangedchangedchangedc';
    await db.query(
      `UPDATE staff SET password_hash = $1, must_change_password = false WHERE id = 1`,
      [changedHash],
    );

    await ensureSeedData();

    const row = (await db.query(
      `SELECT password_hash, must_change_password FROM staff WHERE id = 1`,
    )).rows[0];
    expect(row.password_hash).toBe(changedHash);
    expect(row.must_change_password).toBe(false);
  });

  it('keeps a deactivated admin account deactivated', async () => {
    await db.query(`UPDATE staff SET is_active = false WHERE id = 2`);

    await ensureSeedData();

    const row = (await db.query(`SELECT is_active FROM staff WHERE id = 2`)).rows[0];
    expect(row.is_active).toBe(false);
  });

  it('forces a password change for an account still on the default password', async () => {
    await db.query(
      `UPDATE staff SET password_hash = $1, must_change_password = false WHERE id = 1`,
      [DEFAULT_ADMIN_PASSWORD_HASH],
    );

    await ensureSeedData();

    const row = (await db.query(`SELECT must_change_password FROM staff WHERE id = 1`)).rows[0];
    expect(row.must_change_password).toBe(true);
  });

  it('keeps a renamed / deactivated main branch as the operator left it', async () => {
    await db.query(`UPDATE branches SET name = 'Bole Flagship', is_active = false WHERE id = 1`);

    await ensureSeedData();

    const row = (await db.query(`SELECT name, is_active FROM branches WHERE id = 1`)).rows[0];
    expect(row.name).toBe('Bole Flagship');
    expect(row.is_active).toBe(false);
  });
});

// The startup seed set the id sequences back to MAX(id): after the newest
// branch or account was deleted, a restart gave its id to the next one, which
// inherited the old row's audit log.
describe('ensureSeedData — never hands out an id again', () => {
  afterAll(async () => {
    await db.query(`DELETE FROM branches WHERE name LIKE 'Seed Sequence Test %'`);
    await db.query(`DELETE FROM staff WHERE username LIKE 'seed_sequence_test_%'`);
  });

  it('gives a new branch a new id after the newest branch was deleted and the server restarted', async () => {
    const insert = async (name: string) =>
      Number((await db.query(`INSERT INTO branches (name, address, contact_info, operating_hours) VALUES ($1, '-', '{}', '{}') RETURNING id`, [name])).rows[0].id);
    const deleted = await insert('Seed Sequence Test A');
    await db.query(`DELETE FROM branches WHERE id = $1`, [deleted]);

    await ensureSeedData();

    expect(await insert('Seed Sequence Test B')).toBeGreaterThan(deleted);
  });

  it('gives a new account a new id after the newest account was deleted and the server restarted', async () => {
    const insert = async (username: string) =>
      Number((await db.query(
        `INSERT INTO staff (username, password_hash, full_name) VALUES ($1, $2, 'Seed Sequence Test') RETURNING id`,
        [username, DEFAULT_ADMIN_PASSWORD_HASH],
      )).rows[0].id);
    const deleted = await insert('seed_sequence_test_a');
    await db.query(`DELETE FROM staff WHERE id = $1`, [deleted]);

    await ensureSeedData();

    expect(await insert('seed_sequence_test_b')).toBeGreaterThan(deleted);
  });
});
