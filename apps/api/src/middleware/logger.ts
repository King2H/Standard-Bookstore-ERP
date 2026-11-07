import { Request, Response, NextFunction } from 'express';
import { log } from '../lib/log.js';

/** One line per request once answered: no query string or body, which can hold customer details (#32). */
export function loggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    // Docker checks readiness every 15 seconds: an answered check is not news.
    const routine = path.startsWith('/api/v1/health') && res.statusCode < 400;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : routine ? 'debug' : 'info';
    log[level]({
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
    }, 'request');
  });
  next();
}
