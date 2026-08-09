/**
 * RBAC fix: requireRole() must honor the FULL set of roles a staff member
 * holds for the active branch, not just the single "primary" role recorded
 * on the JWT.
 *
 * Reported bug: a staff member logged in with roles Sales + Stock_Clerk +
 * Purchasor for the branch (primary role happened to be 'Sales', per
 * login's "picks the first role" rule) got 403 "Role 'Sales' is not
 * permitted to perform this action" on POST /api/suppliers, even though
 * requireRole('Admin','Manager','Purchasor','Stock_Clerk') explicitly
 * allows Purchasor and Stock_Clerk — both roles the staff member actually
 * holds. requireRole() was checking only req.staff.role instead of the
 * union req.staff.roles (which requirePermission() already used via
 * req.staff.permissions).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { getPermissionsForRoles } from '../lib/permissions.js';

const STAFF_PREFIX = 'rrmr_test_';
const BRANCH_PREFIX = 'RequireRole MultiRole Test ';

async function createMultiRoleStaff(username: string, roles: string[], branchId: number) {
  const passwordHash = await bcrypt.hash('Test@12345', 10);
  const result = await db.query(
    `INSERT INTO staff (username, password_hash, full_name, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
    [username, passwordHash, 'RR MultiRole Test Staff'],
  );
  const staffId = result.rows[0].id as number;
  for (const role of roles) {
    await db.query(
      `INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [staffId, branchId, role],
    );
  }
  return staffId;
}

// Mirrors auth.service.ts's login()/switchBranch() JWT payload shape exactly
// ({ staffId, role, roles, branchId, permissions }) — this is what a real
// multi-role login actually issues, unlike the single-role-only
// createTestStaff() helper.
function signMultiRoleToken(staffId: number, primaryRole: string, roles: string[], branchId: number): string {
  return jwt.sign(
    { staffId, role: primaryRole, roles, branchId, permissions: getPermissionsForRoles(roles) },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' },
  );
}

describe('requireRole() — multi-role union fix', () => {
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    const branch = await createTestBranch({ name: 'RequireRole MultiRole Test Branch' });
    branchId = branch.branchId;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('1. Reported bug: primary role Sales + held Purchasor/Stock_Clerk can now POST /api/suppliers (previously 403)', async () => {
    const staffId = await createMultiRoleStaff(`${STAFF_PREFIX}multirole1`, ['Sales', 'Stock_Clerk', 'Purchasor'], branchId);
    // 'Sales' listed first — matches login's "picks the first role" rule,
    // reproducing the exact primary-role value from the bug report.
    const token = signMultiRoleToken(staffId, 'Sales', ['Sales', 'Stock_Clerk', 'Purchasor'], branchId);

    const res = await request(getTestApp())
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Branch-Id', String(branchId))
      .send({ name: 'RR MultiRole Test Supplier', supplierType: 'external', contactInfo: { phone: '555-0000' } });

    expect(res.status).toBe(201);

    await db.query(`DELETE FROM suppliers WHERE name = 'RR MultiRole Test Supplier'`);
  });

  it('2. A staff member holding ONLY disallowed roles is still correctly denied (fix does not over-broaden access)', async () => {
    const staffId = await createMultiRoleStaff(`${STAFF_PREFIX}salesonly`, ['Sales'], branchId);
    const token = signMultiRoleToken(staffId, 'Sales', ['Sales'], branchId);

    const res = await request(getTestApp())
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Branch-Id', String(branchId))
      .send({ name: 'Should Not Be Created', supplierType: 'external', contactInfo: { phone: '555-0000' } });

    expect(res.status).toBe(403);
  });

  it('3. Legacy single-role JWT (no roles array at all) still works exactly as before', async () => {
    const staffId = await createMultiRoleStaff(`${STAFF_PREFIX}legacy`, ['Purchasor'], branchId);
    // Deliberately omit `roles`/`permissions` — simulates an old token
    // minted before the multi-role refactor.
    const token = jwt.sign({ staffId, role: 'Purchasor', branchId }, process.env.JWT_SECRET!, { expiresIn: '15m' });

    const res = await request(getTestApp())
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Branch-Id', String(branchId))
      .send({ name: 'RR Legacy Token Test Supplier', supplierType: 'external', contactInfo: { phone: '555-0000' } });

    expect(res.status).toBe(201);
    await db.query(`DELETE FROM suppliers WHERE name = 'RR Legacy Token Test Supplier'`);
  });

  it('4. Legacy single-role JWT for a disallowed role is still correctly denied', async () => {
    const staffId = await createMultiRoleStaff(`${STAFF_PREFIX}legacydenied`, ['Sales'], branchId);
    const token = jwt.sign({ staffId, role: 'Sales', branchId }, process.env.JWT_SECRET!, { expiresIn: '15m' });

    const res = await request(getTestApp())
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Branch-Id', String(branchId))
      .send({ name: 'Should Not Be Created 2', supplierType: 'external', contactInfo: { phone: '555-0000' } });

    expect(res.status).toBe(403);
  });
});
