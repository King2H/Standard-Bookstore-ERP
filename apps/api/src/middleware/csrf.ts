/**
 * CSRF protection using the double-submit cookie pattern.
 *
 * On login: the API sets a `csrf-token` cookie (httpOnly=false so JS can read it).
 * On mutating requests: the client must send the same value in the `X-CSRF-Token` header.
 * The middleware compares cookie value vs header value.
 *
 * This is safe because:
 * - Cross-origin requests cannot read cookies (SameSite=Strict on the refresh cookie)
 * - An attacker cannot forge the X-CSRF-Token header from a different origin
 *
 * Safe methods (GET, HEAD, OPTIONS) are not checked.
 * The /api/auth/login and /api/auth/refresh endpoints are exempt (they establish the session).
 */
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/health', '/api/branches/public']);

/**
 * Generate a CSRF token and set it as a readable cookie.
 * Call this after successful login.
 */
export function setCsrfCookie(res: Response): string {
  const token = randomBytes(32).toString('hex');
  res.cookie('csrf-token', token, {
    httpOnly: false,       // Must be readable by JS
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — matches refresh token lifetime
  });
  return token;
}

/**
 * CSRF validation middleware.
 * Skips safe methods and exempt paths.
 * Returns 403 CSRF_INVALID if the header doesn't match the cookie.
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip safe methods
  if (SAFE_METHODS.has(req.method)) { next(); return; }

  // Skip exempt paths
  if (EXEMPT_PATHS.has(req.path)) { next(); return; }

  const cookieToken = req.cookies?.['csrf-token'] as string | undefined;
  const headerToken = req.headers['x-csrf-token'] as string | undefined;

  // If no cookie exists yet (e.g. first request before login), skip
  if (!cookieToken) { next(); return; }

  if (!headerToken || headerToken !== cookieToken) {
    res.status(403).json({
      error: 'CSRF_INVALID',
      message: 'CSRF token missing or invalid. Include the X-CSRF-Token header.',
    });
    return;
  }

  next();
}
