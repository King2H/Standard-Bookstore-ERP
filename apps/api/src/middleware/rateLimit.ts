/**
 * In-memory rate limiter — no Redis required.
 * Uses a sliding window counter per IP.
 * Suitable for single-instance deployments; for multi-instance, swap to Redis.
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
 */
export function rateLimit(maxRequests: number, windowMs: number, keyPrefix = 'rl') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getIp(req);
    const key = `${keyPrefix}:${ip}`;
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
        message: 'Too many requests. Please try again later.',
        retryAfter,
      });
      return;
    }

    next();
  };
}

// Pre-configured limiters
export const loginRateLimit = rateLimit(10, 15 * 60 * 1000, 'login');   // 10 per 15 min
export const apiRateLimit   = rateLimit(200, 60 * 1000, 'api');          // 200 per minute
