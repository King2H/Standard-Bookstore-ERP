import type { Request, Response } from 'express';
import {
  CancelSupplierReturnRequestSchema,
  CreateSupplierReturnRequestSchema,
  IdParamsSchema,
  SupplierReturnListQuerySchema,
  UpdateSupplierReturnRequestSchema,
  type SupplierReturnDetail,
  type SupplierReturnListResponse,
} from '@bms/shared';
import { assertLocationUsable, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toSupplierReturn, toSupplierReturnDetail } from './supplierReturns.mapper.js';
import * as service from './supplierReturns.service.js';
import type { Actor, ReturnLineInput, SupplierReturnView } from './supplierReturns.types.js';

/**
 * HTTP side of returns to supplier (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: SupplierReturnListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateSupplierReturnRequestSchema },
  update: { params: IdParamsSchema, body: UpdateSupplierReturnRequestSchema },
  cancel: { params: IdParamsSchema, body: CancelSupplierReturnRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles?.length ? roles : [role], branchId };
}

function send(res: Response, r: SupplierReturnView, status = 200): void {
  const body: SupplierReturnDetail = toSupplierReturnDetail(r);
  res.status(status).json(body);
}

/** Every location is one the staff member may use (#72). */
async function usableLines(req: Request, lines: ReturnLineInput[]): Promise<ReturnLineInput[]> {
  for (const locationId of new Set(lines.map((l) => l.locationId))) await assertLocationUsable(req, locationId);
  return lines;
}

const idOf = (req: Request) => valid(req, schemas.byId).params.id;

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list({ branchId: scopedBranch(req), status: query.status, poId: query.poId }, { page: query.page, pageSize: query.pageSize });
  const body: SupplierReturnListResponse = {
    items: result.items.map(toSupplierReturn), total: result.total, page: query.page, pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(idOf(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  const lines = await usableLines(req, body.lines);
  send(res, await service.create(actor(req), { poId: String(body.poId), notes: body.notes ?? null, lines }), 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.update);
  const lines = await usableLines(req, body.lines);
  send(res, await service.update(actor(req), params.id, { notes: body.notes, lines }));
}

export async function sendReturn(req: Request, res: Response): Promise<void> {
  send(res, await service.send(actor(req), idOf(req)));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.cancel);
  send(res, await service.cancel(actor(req), params.id, body.reason));
}
