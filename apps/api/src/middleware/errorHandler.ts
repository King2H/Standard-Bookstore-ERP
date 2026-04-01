import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
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

  // Unexpected error — log and return generic 500
  console.error(
    JSON.stringify({
      level: 'error',
      requestId: req.requestId,
      msg: 'Unhandled error',
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    }),
  );

  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
    details: {},
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
  });
}
