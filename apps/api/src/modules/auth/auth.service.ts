import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import type { Role } from '@bms/shared';
import {
  AuthError,
  BusinessError,
  ConflictError,
  ValidationError,
} from '../../lib/errors.js';
import { insertOutbox } from '../../lib/outbox.js';
import { getPermissionsForRoles } from '../../lib/permissions.js';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 7;

// Password complexity: min 10 chars, upper, lower, digit, special
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{10,}$/;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
}

// ── Security policy helpers ───────────────────────────────────────────────────

export async function getSecurityPolicy(): Promise<{
  maxFailedAttempts: number;
  lockoutMinutes: number;
}> {
  const result = await db.query(
    `SELECT key, value FROM system_config
     WHERE key IN ('max_failed_login_attempts', 'account_lockout_minutes')`,
  );
  const map: Record<string, number> = {};
  for (const row of result.rows) map[row.key] = Number(row.value);
  return {
    maxFailedAttempts: map['max_failed_login_attempts'] ?? 5,
    lockoutMinutes: map['account_lockout_minutes'] ?? 30,
  };
}

// ── Login ────────────────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
  branchId: number,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; mustChangePassword: boolean }> {
  const policy = await getSecurityPolicy();

  // 1. Find staff by username
  const staffResult = await db.query(
    `SELECT id, password_hash, is_active, failed_login_attempts, locked_until, must_change_password
     FROM staff WHERE username = $1`,
    [username],
  );

  if (staffResult.rows.length === 0) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
  }

  const staff = staffResult.rows[0];

  if (!staff.is_active) {
    throw new AuthError('ACCOUNT_INACTIVE', 'This account has been deactivated');
  }

  // 2. Check account lockout
  if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
    const minutesLeft = Math.ceil(
      (new Date(staff.locked_until).getTime() - Date.now()) / 60000,
    );
    throw new AuthError(
      'ACCOUNT_LOCKED',
      `Account is temporarily locked. Try again in ${minutesLeft} minute(s).`,
    );
  }

  // 3. Verify password
  const passwordValid = await bcrypt.compare(password, staff.password_hash);
  if (!passwordValid) {
    // Increment failed attempts and potentially lock
    const newAttempts = (staff.failed_login_attempts ?? 0) + 1;
    const shouldLock = newAttempts >= policy.maxFailedAttempts;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + policy.lockoutMinutes * 60 * 1000)
      : null;

    await db.query(
      `UPDATE staff
       SET failed_login_attempts = $1,
           locked_until = $2
       WHERE id = $3`,
      [newAttempts, lockedUntil, staff.id],
    );

    if (shouldLock) {
      // Emit lockout notification (non-blocking)
      try {
        const notifClient = await db.connect();
        try {
          await notifClient.query('BEGIN');
          await insertOutbox(notifClient, 'auth.failed_login_attempts', {
            username, attemptCount: newAttempts, branchId: null,
          });
          await notifClient.query('COMMIT');
        } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
      } catch { /* non-fatal */ }

      throw new AuthError(
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Account locked for ${policy.lockoutMinutes} minute(s).`,
      );
    }

    throw new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
  }

  // 4. Verify branch role assignment — load ALL roles for this staff+branch
  const allRolesResult = await db.query(
    `SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2 ORDER BY id ASC`,
    [staff.id, branchId],
  );

  if (allRolesResult.rows.length === 0) {
    throw new AuthError(
      'BRANCH_ACCESS_DENIED',
      `No role assignment found for branch ${branchId}`,
    );
  }

  const allRoles = allRolesResult.rows.map(r => r.role as string);
  const role: Role = allRoles[0] as Role; // primary role (backward compat)
  const permissions = getPermissionsForRoles(allRoles);

  // 5. Reset failed attempts + update last_login on successful auth
  await db.query(
    `UPDATE staff
     SET failed_login_attempts = 0,
         locked_until = NULL,
         last_login_at = now()
     WHERE id = $1`,
    [staff.id],
  );

  // 6. Issue access token (includes permissions for fine-grained RBAC)
  const accessToken = jwt.sign(
    { staffId: staff.id, role, roles: allRoles, branchId, permissions },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL },
  );
  // 7. Issue refresh token (store bcrypt hash — never store plaintext)
  const plainRefreshToken = randomUUID();
  const tokenHash = await bcrypt.hash(plainRefreshToken, 10);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Store branch_id + role on the token for reliable refresh (migration 1700000032)
  await db.query(
    `INSERT INTO refresh_tokens (staff_id, token_hash, expires_at, revoked, branch_id, role)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [staff.id, tokenHash, expiresAt, branchId, role],
  );

  return {
    accessToken,
    refreshToken: plainRefreshToken,
    expiresIn: 900,
    mustChangePassword: staff.must_change_password === true,
  };
}

// ── Logout ───────────────────────────────────────────────────────────────────

export async function logout(staffId: number, refreshToken: string): Promise<void> {
  // Find all non-revoked tokens for this staff and revoke the matching one
  const tokens = await db.query(
    `SELECT id, token_hash FROM refresh_tokens
     WHERE staff_id = $1 AND revoked = false AND expires_at > now()`,
    [staffId],
  );

  for (const row of tokens.rows) {
    const matches = await bcrypt.compare(refreshToken, row.token_hash);
    if (matches) {
      await db.query(`UPDATE refresh_tokens SET revoked = true WHERE id = $1`, [row.id]);
      return;
    }
  }
  // Silently succeed even if token not found (idempotent logout)
}

// ── Refresh ──────────────────────────────────────────────────────────────────

export async function refresh(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  // Fetch all non-revoked, non-expired tokens for active staff.
  // branch_id and role are stored directly on the token (migration 1700000032).
  // Fall back to staff_branch_roles JOIN for tokens issued before the migration.
  const tokens = await db.query(
    `SELECT rt.id, rt.token_hash, rt.staff_id, rt.branch_id, rt.role,
            sbr_fallback.role AS fallback_role, sbr_fallback.branch_id AS fallback_branch_id
     FROM refresh_tokens rt
     JOIN staff s ON s.id = rt.staff_id
     LEFT JOIN LATERAL (
       SELECT role, branch_id FROM staff_branch_roles
       WHERE staff_id = rt.staff_id
       ORDER BY id ASC LIMIT 1
     ) sbr_fallback ON true
     WHERE rt.revoked = false
       AND rt.expires_at > now()
       AND s.is_active = true
     LIMIT 100`,
  );

  for (const row of tokens.rows) {
    const matches = await bcrypt.compare(refreshToken, row.token_hash);
    if (matches) {
      // Use stored context if available, otherwise fall back to first role assignment
      const role     = (row.role      ?? row.fallback_role)      as string;
      const branchId = (row.branch_id ?? row.fallback_branch_id) as number;

      if (!role || !branchId) {
        throw new AuthError('TOKEN_REVOKED', 'Refresh token is invalid or expired');
      }

      // Load all roles for this staff+branch to compute the full permission set
      const allRolesResult = await db.query(
        `SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2 ORDER BY id ASC`,
        [row.staff_id, branchId],
      );
      const allRoles = allRolesResult.rows.map(r => r.role as string);
      // Fall back to the stored role if no assignments found (edge case)
      const permissions = getPermissionsForRoles(allRoles.length ? allRoles : [role]);

      const accessToken = jwt.sign(
        { staffId: row.staff_id, role, roles: allRoles.length ? allRoles : [role], branchId, permissions },
        getJwtSecret(),
        { expiresIn: ACCESS_TOKEN_TTL },
      );
      return { accessToken, expiresIn: 900 };
    }
  }

  throw new AuthError('TOKEN_REVOKED', 'Refresh token is invalid or expired');
}

// ── Get Branches For User ─────────────────────────────────────────────────────
// Returns all branches the staff member has access to, with their roles per branch.
// Used by the login page (branch selection) and the branch switcher.

export async function getBranchesForUser(
  staffId: number,
): Promise<Array<{ branchId: number; branchName: string; roles: string[]; isAllBranches: boolean }>> {
  // Check is_all_branches flag
  let isAllBranches = false;
  try {
    const abRes = await db.query(`SELECT is_all_branches FROM staff WHERE id = $1`, [staffId]);
    isAllBranches = abRes.rows[0]?.is_all_branches === true;
  } catch { /* column may not exist yet */ }

  if (isAllBranches) {
    // Return all active branches with the staff's assigned roles (or empty if none)
    const branchRes = await db.query(
      `SELECT b.id, b.name,
              COALESCE(
                (SELECT json_agg(sbr.role ORDER BY sbr.id)
                 FROM staff_branch_roles sbr
                 WHERE sbr.staff_id = $1 AND sbr.branch_id = b.id),
                '[]'::json
              ) AS roles
       FROM branches b
       WHERE b.is_active = true
       ORDER BY b.name ASC`,
      [staffId],
    );
    return branchRes.rows.map(r => ({
      branchId: r.id as number,
      branchName: r.name as string,
      roles: (r.roles as string[]) ?? [],
      isAllBranches: true,
    }));
  }

  // Normal staff: return only branches they have role assignments for
  const res = await db.query(
    `SELECT b.id, b.name, json_agg(sbr.role ORDER BY sbr.id) AS roles
     FROM staff_branch_roles sbr
     JOIN branches b ON b.id = sbr.branch_id
     WHERE sbr.staff_id = $1 AND b.is_active = true
     GROUP BY b.id, b.name
     ORDER BY b.name ASC`,
    [staffId],
  );
  return res.rows.map(r => ({
    branchId: r.id as number,
    branchName: r.name as string,
    roles: (r.roles as string[]) ?? [],
    isAllBranches: false,
  }));
}

// ── Switch Branch ─────────────────────────────────────────────────────────────
// Issues a new access token for a different branch.
// The refresh token cookie is NOT changed — only the access token is reissued.

export async function switchBranch(
  staffId: number,
  targetBranchId: number,
): Promise<{ accessToken: string; expiresIn: number }> {
  // Verify staff is still active
  const staffRes = await db.query(`SELECT is_active FROM staff WHERE id = $1`, [staffId]);
  if (!staffRes.rows.length || !staffRes.rows[0].is_active) {
    throw new AuthError('ACCOUNT_INACTIVE', 'Account is deactivated');
  }

  // Check is_all_branches
  let isAllBranches = false;
  try {
    const abRes = await db.query(`SELECT is_all_branches FROM staff WHERE id = $1`, [staffId]);
    isAllBranches = abRes.rows[0]?.is_all_branches === true;
  } catch { /* column may not exist yet */ }

  // Load roles for the target branch
  const rolesRes = await db.query(
    `SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2 ORDER BY id ASC`,
    [staffId, targetBranchId],
  );

  if (rolesRes.rows.length === 0 && !isAllBranches) {
    throw new AuthError('BRANCH_ACCESS_DENIED', `No role assignment found for branch ${targetBranchId}`);
  }

  const allRoles = rolesRes.rows.map(r => r.role as string);
  const role = (allRoles[0] ?? 'Admin') as import('@bms/shared').Role;
  const permissions = getPermissionsForRoles(allRoles.length ? allRoles : ['Admin']);

  const accessToken = jwt.sign(
    { staffId, role, roles: allRoles, branchId: targetBranchId, permissions },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL },
  );

  return { accessToken, expiresIn: 900 };
}

// ── Create Staff ─────────────────────────────────────────────────────────────

export async function createStaff(data: {
  username: string;
  password: string;
  fullName: string;
}): Promise<{ staffId: number }> {
  if (!PASSWORD_REGEX.test(data.password)) {
    throw new ValidationError(
      'Password must be at least 10 characters and contain uppercase, lowercase, digit, and special character',
    );
  }

  const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let result;
    try {
      result = await client.query(
        `INSERT INTO staff (username, password_hash, full_name, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [data.username, passwordHash, data.fullName],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('DUPLICATE_USERNAME', `Username '${data.username}' already exists`);
      }
      throw err;
    }

    const staffId = result.rows[0].id;

    // Write audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
       VALUES (NULL, 'SYSTEM', 'CREATE', 'staff', $1, $2)`,
      [String(staffId), JSON.stringify({ username: data.username })],
    );

    await client.query('COMMIT');
    return { staffId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Deactivate ───────────────────────────────────────────────────────────────

export async function deactivateStaff(staffId: number): Promise<void> {
  const result = await db.query(
    `UPDATE staff SET is_active = false WHERE id = $1 RETURNING username`,
    [staffId],
  );
  // Revoke all refresh tokens immediately
  await db.query(`UPDATE refresh_tokens SET revoked = true WHERE staff_id = $1`, [staffId]);

  // Emit notification (non-blocking)
  try {
    const username = result.rows[0]?.username ?? String(staffId);
    const notifClient = await db.connect();
    try {
      await notifClient.query('BEGIN');
      await insertOutbox(notifClient, 'auth.staff_deactivated', { username, branchId: null });
      await notifClient.query('COMMIT');
    } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
  } catch { /* non-fatal */ }
}

// ── Reactivate ───────────────────────────────────────────────────────────────

export async function reactivateStaff(staffId: number): Promise<void> {
  const result = await db.query(
    `UPDATE staff SET is_active = true WHERE id = $1 RETURNING id`,
    [staffId],
  );
  if (result.rows.length === 0) {
    throw new BusinessError('STAFF_NOT_FOUND', `Staff ${staffId} not found`);
  }
  // Role assignments are retained (soft deactivation only)
}

// ── Admin: Reset Password ─────────────────────────────────────────────────────
// Sets a temporary password and forces must_change_password = true

export async function adminResetPassword(
  targetStaffId: number,
  temporaryPassword: string,
  staffCtx: { staffId: number; role: string },
): Promise<void> {
  if (!PASSWORD_REGEX.test(temporaryPassword)) {
    throw new ValidationError(
      'Temporary password must be at least 10 characters and contain uppercase, lowercase, digit, and special character',
    );
  }

  const newHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE staff
       SET password_hash = $1,
           must_change_password = true,
           failed_login_attempts = 0,
           locked_until = NULL,
           password_changed_at = now()
       WHERE id = $2
       RETURNING id`,
      [newHash, targetStaffId],
    );
    if (result.rows.length === 0) {
      throw new BusinessError('STAFF_NOT_FOUND', `Staff ${targetStaffId} not found`);
    }

    // Revoke all existing refresh tokens — forces re-login with new password
    await client.query(
      `UPDATE refresh_tokens SET revoked = true WHERE staff_id = $1`,
      [targetStaffId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'UPDATE', 'staff', $3, $4)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(targetStaffId),
        JSON.stringify({ action: 'admin_password_reset', mustChangePassword: true }),
      ],
    );

    // Emit notification (non-blocking)
    const targetRes = await client.query('SELECT username FROM staff WHERE id = $1', [targetStaffId]);
    const targetUsername = targetRes.rows[0]?.username ?? String(targetStaffId);
    const adminRes = await client.query('SELECT username FROM staff WHERE id = $1', [staffCtx.staffId]);
    const adminName = adminRes.rows[0]?.username ?? String(staffCtx.staffId);
    await insertOutbox(client, 'auth.password_reset', { username: targetUsername, adminName, branchId: null });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Admin: Unlock Account ─────────────────────────────────────────────────────

export async function unlockAccount(
  targetStaffId: number,
  staffCtx: { staffId: number; role: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE staff
       SET failed_login_attempts = 0,
           locked_until = NULL
       WHERE id = $1
       RETURNING id`,
      [targetStaffId],
    );
    if (result.rows.length === 0) {
      throw new BusinessError('STAFF_NOT_FOUND', `Staff ${targetStaffId} not found`);
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'UPDATE', 'staff', $3, $4)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(targetStaffId),
        JSON.stringify({ action: 'account_unlocked' }),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Get Staff by ID ───────────────────────────────────────────────────────────

export async function getStaffById(staffId: number): Promise<{
  id: number;
  username: string;
  fullName: string;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  createdAt: string;
  roles: Array<{ branchId: number; branchName: string | null; role: string }>;
}> {
  const result = await db.query(
    `SELECT s.id, s.username, s.full_name, s.is_active,
            s.failed_login_attempts, s.locked_until, s.must_change_password,
            s.last_login_at, s.password_changed_at, s.created_at,
            COALESCE(json_agg(
              json_build_object('branchId', sbr.branch_id, 'branchName', b.name, 'role', sbr.role)
            ) FILTER (WHERE sbr.staff_id IS NOT NULL), '[]') AS roles
     FROM staff s
     LEFT JOIN staff_branch_roles sbr ON sbr.staff_id = s.id
     LEFT JOIN branches b ON b.id = sbr.branch_id
     WHERE s.id = $1
     GROUP BY s.id`,
    [staffId],
  );

  if (result.rows.length === 0) {
    throw new BusinessError('STAFF_NOT_FOUND', `Staff ${staffId} not found`);
  }

  const r = result.rows[0];
  return {
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    isActive: r.is_active,
    failedLoginAttempts: r.failed_login_attempts,
    lockedUntil: r.locked_until ? new Date(r.locked_until).toISOString() : null,
    mustChangePassword: r.must_change_password,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    passwordChangedAt: r.password_changed_at ? new Date(r.password_changed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    roles: r.roles,
  };
}

// ── Assign Roles ─────────────────────────────────────────────────────────────
// Replaces ALL role assignments for a staff member with the provided set.
// Supports multiple roles per branch (e.g. Manager + Finance_Officer at same branch).

export async function assignRoles(
  staffId: number,
  roles: Array<{ branchId: number; role: Role }>,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Delete ALL existing assignments first — this handles removals and branch switches
    await client.query(
      `DELETE FROM staff_branch_roles WHERE staff_id = $1`,
      [staffId],
    );

    // Insert the new complete set — ON CONFLICT DO NOTHING handles duplicates gracefully
    for (const { branchId, role } of roles) {
      await client.query(
        `INSERT INTO staff_branch_roles (staff_id, branch_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (staff_id, branch_id, role) DO NOTHING`,
        [staffId, branchId, role],
      );
    }

    // Write audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
       VALUES (NULL, 'SYSTEM', 'UPDATE', 'staff_roles', $1, $2)`,
      [String(staffId), JSON.stringify({ assignments: roles })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
