import { Router, Request, Response } from 'express';
import type { HealthResponse, LivenessResponse, ReadinessResponse } from '@bms/shared';
import { checkDbConnection } from '../db/index.js';
import { isShuttingDown } from '../lib/readiness.js';
import { APP_VERSION } from '../lib/version.js';

const router = Router();

/** The database and the version, as before #32: the upgrade script reads the version here. */
router.get('/health', async (_req: Request, res: Response) => {
  const dbOk = await checkDbConnection();

  const status = dbOk ? 'ok' : 'degraded';
  const httpStatus = dbOk ? 200 : 503;

  const body: HealthResponse = {
    status,
    db: dbOk ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
  };
  res.status(httpStatus).json(body);
});

/** Liveness (#32, 3a): the process answers. */
router.get('/health/live', (_req: Request, res: Response) => {
  const body: LivenessResponse = { status: 'ok', version: APP_VERSION };
  res.json(body);
});

/** Readiness (#32, 3a): the database answers and the API is not shutting down. */
router.get('/health/ready', async (_req: Request, res: Response) => {
  const shuttingDown = isShuttingDown();
  const dbOk = await checkDbConnection();
  const ready = dbOk && !shuttingDown;
  const body: ReadinessResponse = { status: ready ? 'ready' : 'not_ready', database: dbOk ? 'ok' : 'error', shuttingDown };
  res.status(ready ? 200 : 503).json(body);
});

export default router;
