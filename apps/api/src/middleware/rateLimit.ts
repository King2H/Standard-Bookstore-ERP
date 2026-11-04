/**
 * In-memory sign-in limiter — no Redis required.
 * A fixed window counter per key. Counters are per process, so with several
 * API instances each enforces its own limit (shared limits: #32).
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';

interface WindowEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, WindowEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

// req.ip honours the app's `trust proxy` setting (TRUST_PROXY), so a client
// cannot pick its own key by sending X-Forwarded-For.
function getIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * The sign-in limiter: failed attempts only, keyed by IP:username so one
 * person's mistakes do not lock out others on the same IP (an office or a
 * shared counter PC). Pre-login and login share the counter. A refused attempt
 * (any 4xx) counts when its answer is sent; a successful sign-in never counts
 * (#240, A1; was: every request counted, twice per sign-in, so five sign-ins in
 * 15 minutes locked a staff member out).
 * Limit: 10 failed attempts per username per IP per 15 minutes.
 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const username = (req.body?.username as string | undefined)?.toLowerCase().trim() ?? 'unknown';
  const key = `login:${getIp(req)}:${username}`;
  const now = Date.now();
  const entry = store.get(key);
  if (entry && entry.resetAt >= now && entry.count >= LOGIN_MAX_FAILURES) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    next(new AppError('RATE_LIMIT_EXCEEDED', 'Too many failed sign-in attempts. Please try again later.', 429, { retryAfter }));
    return;
  }
  res.on('finish', () => {
    if (res.statusCode < 400 || res.statusCode >= 500 || res.statusCode === 429) return;
    const at = Date.now();
    let failures = store.get(key);
    if (!failures || failures.resetAt < at) {
      failures = { count: 0, resetAt: at + LOGIN_WINDOW_MS };
      store.set(key, failures);
    }
    failures.count++;
  });
  next();
}
