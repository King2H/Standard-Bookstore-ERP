import type { Request, Response, NextFunction } from 'express';
import type { HttpConfig } from '../lib/env.js';

/**
 * CORS that fails closed: a cross-origin request gets CORS headers only if its
 * origin is listed in FRONTEND_URL (or, in development without FRONTEND_URL, any
 * origin). Otherwise the browser blocks the response. Same-origin requests, such
 * as those through the web app's proxy, need no CORS headers at all.
 */
export function corsMiddleware({ allowedOrigins, allowAnyOrigin }: Pick<HttpConfig, 'allowedOrigins' | 'allowAnyOrigin'>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    if (origin && (allowAnyOrigin || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Branch-Id,X-CSRF-Token,Idempotency-Key');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
