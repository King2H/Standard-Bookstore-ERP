import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';

/**
 * The unversioned /api paths were an alias of /api/v1 until the web app moved
 * to /api/v1 (M6, #23). They now answer 410 with the address to use instead,
 * so a browser tab still running the old web app, or a forgotten integration,
 * is told what changed rather than getting a bare 404. Mounted on /api before
 * the CSRF check, which would otherwise answer first.
 */
export function unversionedApiGone(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/v1' || req.path.startsWith('/v1/')) {
    next();
    return;
  }
  res.setHeader('Link', `</api/v1${req.url}>; rel="successor-version"`);
  next(new AppError('DEPRECATED', `This API address moved to /api/v1${req.path}. Reload the page.`, 410));
}
