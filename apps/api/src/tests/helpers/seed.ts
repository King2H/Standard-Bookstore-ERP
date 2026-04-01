import { db } from '../../db/index.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Role } from '@bms/shared';

/**
 * Creates a test staff member directly in the DB.
 * Returns the staff id and a valid JWT for use in test requests.
 */
export async function createTestStaff(opts: {
  username?: string;
  role?: Role;
  branchId?: number;
}): Promise<{ staffId: number; token: string; role: Role; branchId: number }> {
  const username = opts.username ?? `test_staff_${Date.now()}`;
  const role: Role = opts.role ?? 'Admin';
  const branchId = opts.branchId ?? 1;
  const passwordHash = await bcrypt.hash('Test@12345', 10);

  const result = await db.query(
    `INSERT INTO staff (username, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id`,
    [username, passwordHash, 'Test Staff'],
  );

  const staffId: number = result.rows[0].id;

  // Assign role to branch
  await db.query(
    `INSERT INTO staff_branch_roles (staff_id, branch_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [staffId, branchId, role],
  );

  const token = jwt.sign(
    { staffId, role, branchId },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' },
  );

  return { staffId, token, role, branchId };
}

/**
 * Creates a test branch directly in the DB.
 */
export async function createTestBranch(opts?: { name?: string }): Promise<{ branchId: number }> {
  const name = opts?.name ?? `Test Branch ${Date.now()}`;

  const result = await db.query(
    `INSERT INTO branches (name, address, contact_info, operating_hours, is_active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [
      name,
      '123 Test Street',
      JSON.stringify({ phone: '555-0000', email: 'test@branch.com' }),
      JSON.stringify({ mon: '09:00-18:00', tue: '09:00-18:00' }),
    ],
  );

  return { branchId: result.rows[0].id };
}
