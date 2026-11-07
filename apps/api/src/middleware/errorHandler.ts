import { Request, Response, NextFunction } from 'express';
import { closedPeriodError } from '../db/errors.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/log.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // A write the database refused because its day or month is closed (#175).
  err = closedPeriodError(err) ?? err;
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      details: err.details ?? {},
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Unexpected error: logged with its stack (the log stays on the install), a generic 500 answered.
  log.error({ err }, 'Unhandled error');

  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
    details: {},
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
  });
}
