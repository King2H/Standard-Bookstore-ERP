import { Router, Request, Response } from 'express';
import { checkDbConnection } from '../db/index.js';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  const dbOk = await checkDbConnection();

  const status = dbOk ? 'ok' : 'degraded';
  const httpStatus = dbOk ? 200 : 503;

  res.status(httpStatus).json({
    status,
    db: dbOk ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
  });
});

export default router;
