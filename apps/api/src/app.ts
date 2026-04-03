import express from 'express';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './middleware/requestId.js';
import { loggerMiddleware } from './middleware/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import auditLogsRouter from './routes/auditLogs.js';
import authRouter from './modules/auth/auth.routes.js';
import branchRouter from './modules/branch/branch.routes.js';
import configRouter from './modules/config/config.routes.js';
import bankAccountRouter from './modules/bankAccount/bankAccount.routes.js';
import locationRouter from './modules/location/location.routes.js';

export function createApp() {
  const app = express();

  // ── Core middleware ──────────────────────────────────────────────────────
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(loggerMiddleware);

  // ── Routes ───────────────────────────────────────────────────────────────
  app.use('/api', healthRouter);
  app.use('/api', authRouter);
  app.use('/api', branchRouter);
  app.use('/api', configRouter);
  app.use('/api', bankAccountRouter);
  app.use('/api', locationRouter);
  app.use('/api', auditLogsRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  // ── Error handler (must be last) ─────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
