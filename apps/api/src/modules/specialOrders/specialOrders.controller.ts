import type { Request, Response } from 'express';
import { SpecialOrderListQuerySchema, type SpecialOrderListResponse } from '@bms/shared';
import { scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import * as service from './specialOrders.service.js';
import type { OpenLineRecord } from './specialOrders.types.js';
import { poNumber } from '../procurement/procurement.mapper.js';

/** HTTP side of special orders (#174): validated request -> service -> response. */

export const schemas = {
  list: { query: SpecialOrderListQuerySchema },
};

const toResponse = (r: OpenLineRecord) => ({
  ...r,
  orderedAt: r.orderedAt.toISOString(),
  toOrder: Math.max(0, r.onOrder - r.linked),
  purchaseOrders: r.purchaseOrders.map((p) => ({ ...p, poNumber: poNumber(p.poId) })),
});

/** The session branch's special-order lines with copies on order, oldest order first. */
export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(scopedBranch(req), { toOrderOnly: query.toOrder === 'true' }, { page: query.page, pageSize: query.pageSize });
  const body: SpecialOrderListResponse = {
    items: result.items.map(toResponse), total: result.total, page: query.page, pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}
