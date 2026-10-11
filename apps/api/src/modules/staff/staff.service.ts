import bcrypt from 'bcrypt';
import { db } from '../../db/index.js';
import type { Role } from '@bms/shared';
import {
  BusinessError,
  ConflictError,
  ValidationError,
} from '../../lib/errors.js';
import { insertOutbox } from '../../lib/outbox.js';

// Staff administration, still in its v1 form until auth part 2 (#21).

const BCRYPT_ROUNDS = 12;

// Password complexity: min 10 chars, upper, lower, digit, special
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{10,}$/;

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
  // End every session at once (#21, owner decision 5a)
  await db.query(
    `UPDATE staff_sessions SET revoked_at = now(), revoked_reason = 'deactivated' WHERE staff_id = $1 AND revoked_at IS NULL`,
    [staffId],
  );

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

    // End every session — forces re-login with the new password
    await client.query(
      `UPDATE staff_sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE staff_id = $1 AND revoked_at IS NULL`,
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
