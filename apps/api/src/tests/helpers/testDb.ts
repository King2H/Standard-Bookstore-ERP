import { db } from '../../db/index.js';
import { PoolClient } from 'pg';

/**
 * Wraps a test in a DB transaction that is always rolled back.
 */
export async function withTestTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deletes test staff rows (and their dependent rows) by username prefix.
 * NEVER truncates — seed data (superadmin, admin, Main Branch) is preserved.
 */
export async function cleanTestStaff(usernamePrefix: string): Promise<void> {
  await db.query(
    `DELETE FROM refresh_tokens WHERE staff_id IN (
       SELECT id FROM staff WHERE username LIKE $1
     )`,
    [`${usernamePrefix}%`],
  );
  await db.query(
    `DELETE FROM staff_branch_roles WHERE staff_id IN (
       SELECT id FROM staff WHERE username LIKE $1
     )`,
    [`${usernamePrefix}%`],
  );
  await db.query(`DELETE FROM staff WHERE username LIKE $1`, [`${usernamePrefix}%`]);
}

/**
 * Deletes test branches by name prefix, along with their dependent rows.
 * NEVER truncates — the seeded "Main Branch" is preserved.
 */
export async function cleanTestBranches(namePrefix: string): Promise<void> {
  // Remove staff_locations referencing locations in these branches first
  await db.query(
    `DELETE FROM staff_locations WHERE location_id IN (
       SELECT id FROM locations WHERE branch_id IN (
         SELECT id FROM branches WHERE name LIKE $1
       )
     )`,
    [`${namePrefix}%`],
  );
  // Remove locations in these branches
  await db.query(
    `DELETE FROM locations WHERE branch_id IN (
       SELECT id FROM branches WHERE name LIKE $1
     )`,
    [`${namePrefix}%`],
  );
  // Remove staff_branch_roles referencing these branches first
  await db.query(
    `DELETE FROM staff_branch_roles WHERE branch_id IN (
       SELECT id FROM branches WHERE name LIKE $1
     )`,
    [`${namePrefix}%`],
  );
  await db.query(
    `DELETE FROM branch_config WHERE branch_id IN (
       SELECT id FROM branches WHERE name LIKE $1
     )`,
    [`${namePrefix}%`],
  );
  await db.query(`DELETE FROM branches WHERE name LIKE $1`, [`${namePrefix}%`]);
}

/**
 * Cleans branch_config rows for a specific branch id.
 */
export async function cleanBranchConfig(branchId: number): Promise<void> {
  await db.query(`DELETE FROM branch_config WHERE branch_id = $1`, [branchId]);
}

/**
 * Cleans bank_accounts and bank_reconciliation rows for a specific branch.
 */
export async function cleanBankAccounts(branchId: number): Promise<void> {
  await db.query(
    `DELETE FROM bank_reconciliation WHERE bank_account_id IN (
       SELECT id FROM bank_accounts WHERE branch_id = $1
     )`,
    [branchId],
  );
  await db.query(`DELETE FROM bank_accounts WHERE branch_id = $1`, [branchId]);
}

/**
 * Cleans staff_locations rows for a specific staff member.
 */
export async function cleanStaffLocations(staffId: number): Promise<void> {
  await db.query(`DELETE FROM staff_locations WHERE staff_id = $1`, [staffId]);
}
