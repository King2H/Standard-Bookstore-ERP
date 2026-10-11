import type { Request, Response } from 'express';
import { KpiPeriodQuerySchema, KpiQuerySchema } from '@bms/shared';
import { scopedBranchOrAll } from '../../../lib/scope.js';
import { valid } from '../../../middleware/validate.js';
import * as service from './kpis.service.js';

/** HTTP side of the dashboard KPIs (A3). */

export const schemas = {
  kpis: { query: KpiQuerySchema },
  period: { query: KpiPeriodQuerySchema },
};

export async function kpis(req: Request, res: Response): Promise<void> {
  valid(req, schemas.kpis);
  res.json(await service.getKpis(scopedBranchOrAll(req)));
}

export async function period(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.period);
  res.json(await service.getPeriodKpis(scopedBranchOrAll(req), query.period));
}
