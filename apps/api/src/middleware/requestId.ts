import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { withRequestContext } from '../lib/log.js';

/** A request ID from the client is taken only as a short, safe token: it is written to the logs (#32). */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const given = req.headers['x-request-id'];
  req.requestId = typeof given === 'string' && SAFE_ID.test(given) ? given : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  withRequestContext(req, next);
}
