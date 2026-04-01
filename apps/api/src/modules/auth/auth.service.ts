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

// ── Login ────────────────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
  branchId: number,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  // 1. Find staff by username
  const staffResult = await db.query(
    `SELECT id, password_hash, is_active FROM staff WHERE username = $1`,
    [username],
  );

  if (staffResult.rows.length === 0) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
  }

  const staff = staffResult.rows[0];

  if (!staff.is_active) {
    throw new AuthError('ACCOUNT_INACTIVE', 'This account has been deactivated');
  }

  // 2. Verify password
  const passwordValid = await bcrypt.compare(password, staff.password_hash);
  if (!passwordValid) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
  }

  // 3. Verify branch role assignment
  const roleResult = await db.query(
    `SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2`,
    [staff.id, branchId],
  );

  if (roleResult.rows.length === 0) {
    throw new AuthError(
      'BRANCH_ACCESS_DENIED',
      `No role assignment found for branch ${branchId}`,
    );
  }

  const role: Role = roleResult.rows[0].role;

  // 4. Issue access token
  const accessToken = jwt.sign(
    { staffId: staff.id, role, branchId },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL },
  );

  // 5. Issue refresh token (store bcrypt hash — never store plaintext)
  const plainRefreshToken = randomUUID();
  const tokenHash = await bcrypt.hash(plainRefreshToken, 10);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO refresh_tokens (staff_id, token_hash, expires_at, revoked)
     VALUES ($1, $2, $3, false)`,
    [staff.id, tokenHash, expiresAt],
  );

  return { accessToken, refreshToken: plainRefreshToken, expiresIn: 900 };
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
  // Find all non-revoked, non-expired tokens
  const tokens = await db.query(
    `SELECT rt.id, rt.token_hash, rt.staff_id, sbr.role, sbr.branch_id
     FROM refresh_tokens rt
     JOIN staff_branch_roles sbr ON sbr.staff_id = rt.staff_id
     JOIN staff s ON s.id = rt.staff_id
     WHERE rt.revoked = false
       AND rt.expires_at > now()
       AND s.is_active = true
     LIMIT 100`,
  );

  for (const row of tokens.rows) {
    const matches = await bcrypt.compare(refreshToken, row.token_hash);
    if (matches) {
      const accessToken = jwt.sign(
        { staffId: row.staff_id, role: row.role, branchId: row.branch_id },
        getJwtSecret(),
        { expiresIn: ACCESS_TOKEN_TTL },
      );
      return { accessToken, expiresIn: 900 };
    }
  }

  throw new AuthError('TOKEN_REVOKED', 'Refresh token is invalid or expired');
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
  await db.query(`UPDATE staff SET is_active = false WHERE id = $1`, [staffId]);
  // Revoke all refresh tokens immediately
  await db.query(`UPDATE refresh_tokens SET revoked = true WHERE staff_id = $1`, [staffId]);
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

// ── Assign Roles ─────────────────────────────────────────────────────────────

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

    // Insert the new complete set
    for (const { branchId, role } of roles) {
      await client.query(
        `INSERT INTO staff_branch_roles (staff_id, branch_id, role)
         VALUES ($1, $2, $3)`,
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
