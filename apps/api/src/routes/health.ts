import { Router, Request, Response } from 'express';
import type { HealthResponse } from '@bms/shared';
import { checkDbConnection } from '../db/index.js';
import { APP_VERSION } from '../lib/version.js';

const router = Router();

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

export default router;
