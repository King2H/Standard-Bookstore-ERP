import type { Request, Response } from 'express';
import {
  CancelStockCountRequestSchema,
  EnterStockCountsRequestSchema,
  IdParamsSchema,
  OpenStockCountRequestSchema,
  PostStockCountRequestSchema,
  RecountRequestSchema,
  StockCountListQuerySchema,
  type StockCountDetail,
  type StockCountListResponse,
} from '@bms/shared';
import { assertLocationUsable, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toStockCount, toStockCountDetail } from './stockCounts.mapper.js';
import * as service from './stockCounts.service.js';
import type { Actor, StockCountView } from './stockCounts.types.js';

/**
 * HTTP side of stock counts (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: StockCountListQuerySchema },
  byId: { params: IdParamsSchema },
  open: { body: OpenStockCountRequestSchema },
  counts: { params: IdParamsSchema, body: EnterStockCountsRequestSchema },
  recount: { params: IdParamsSchema, body: RecountRequestSchema },
  post: { params: IdParamsSchema, body: PostStockCountRequestSchema },
  cancel: { params: IdParamsSchema, body: CancelStockCountRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles?.length ? roles : [role], branchId };
}

function send(res: Response, count: StockCountView, status = 200): void {
  const body: StockCountDetail = toStockCountDetail(count);
  res.status(status).json(body);
}

const idOf = (req: Request) => valid(req, schemas.byId).params.id;

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    { branchId: scopedBranch(req), status: query.status, locationId: query.locationId },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: StockCountListResponse = {
    items: result.items.map(toStockCount), total: result.total, page: query.page, pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(actor(req), idOf(req)));
}

/** The location is one the staff member may use (#72). */
export async function open(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.open);
  await assertLocationUsable(req, body.locationId);
  send(res, await service.open(actor(req), { locationId: body.locationId, scope: body.scope, bookIds: body.bookIds ?? null, notes: body.notes ?? null }), 201);
}

export async function enterCounts(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.counts);
  send(res, await service.enterCounts(actor(req), params.id, body.items));
}

export async function submit(req: Request, res: Response): Promise<void> {
  send(res, await service.submit(actor(req), idOf(req)));
}

export async function recount(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.recount);
  send(res, await service.recount(actor(req), params.id, body.bookIds));
}

export async function post(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.post);
  send(res, await service.post(actor(req), params.id, body.zeroBookIds));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.cancel);
  send(res, await service.cancel(actor(req), params.id, body.reason));
}
