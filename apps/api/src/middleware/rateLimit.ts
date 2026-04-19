/**
 * In-memory rate limiter — no Redis required.
 * Uses a sliding window counter per key.
 * Login limiter keys by IP:username to avoid blocking all users from the same IP
 * (important for localhost/office environments where everyone shares one IP).
 */
import type { Request, Response, NextFunction } from 'express';

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

function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Creates a rate limit middleware.
 * @param maxRequests - max requests allowed in the window
 * @param windowMs - window duration in milliseconds
 * @param keyPrefix - prefix to namespace different limiters
 * @param keyFn - optional function to derive the rate limit key from the request
 */
export function rateLimit(
  maxRequests: number,
  windowMs: number,
  keyPrefix = 'rl',
  keyFn?: (req: Request) => string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keyPart = keyFn ? keyFn(req) : getIp(req);
    const key = `${keyPrefix}:${keyPart}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many login attempts. Please try again later.',
        retryAfter,
      });
      return;
    }

    next();
  };
}

/**
 * Login rate limiter — keyed by IP:username.
 * This prevents one user's failed attempts from locking out other users
 * on the same IP (e.g. office/localhost environments).
 * Limit: 10 attempts per username per IP per 15 minutes.
 */
export const loginRateLimit = rateLimit(
  10,
  15 * 60 * 1000,
  'login',
  (req: Request) => {
    const ip = getIp(req);
    const username = (req.body?.username as string | undefined)?.toLowerCase().trim() ?? 'unknown';
    return `${ip}:${username}`;
  },
);

export const apiRateLimit = rateLimit(200, 60 * 1000, 'api'); // 200 per minute per IP
