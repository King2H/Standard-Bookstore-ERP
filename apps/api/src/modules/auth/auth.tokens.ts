import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getPermissionsForRoles } from '../../lib/permissions.js';
import { ACCESS_TOKEN_SECONDS } from './auth.policy.js';

/**
 * Access and refresh tokens (#21). The access token names the session; the
 * server reads the session and the roles from the database on every request
 * (owner decision 5a). The roles and permissions it also carries are there
 * for the web app's menus only.
 */

export interface AccessTokenClaims {
  sid: string;
  staffId: number;
  branchId: number;
  /** For the web app; the server reads the tenant from the database. */
  tenantId: number;
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET not configured');
  return value;
}

export function signAccessToken(claims: AccessTokenClaims, roles: string[]): string {
  return jwt.sign(
    { ...claims, role: roles[0], roles, permissions: getPermissionsForRoles(roles) },
    secret(),
    { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_SECONDS },
  );
}

/** The claims of a valid access token; throws jsonwebtoken's errors otherwise. */
export function verifyAccessToken(token: string): Partial<AccessTokenClaims> {
  return jwt.verify(token, secret(), { algorithms: ['HS256'] }) as Partial<AccessTokenClaims>;
}

/** 256 random bits; only its hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A high-entropy token needs no slow hash (unlike a password): SHA-256 makes it findable by index. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
