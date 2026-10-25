import type { Request, Response } from 'express';
import {
  IdParamsSchema,
  ServiceBranchFeeRequestSchema,
  ServiceListQuerySchema,
  ServiceRequestSchema,
  type Service,
  type ServiceListResponse,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import { toServiceResponse } from './services.mapper.js';
import * as policy from './services.policy.js';
import * as service from './services.service.js';
import type { Actor, LifecycleAction } from './services.types.js';

/**
 * HTTP side of the services list (A3): validated request -> service ->
 * response. Fees are read and set for the session branch.
 */

export const schemas = {
  list: { query: ServiceListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: ServiceRequestSchema },
  update: { params: IdParamsSchema, body: ServiceRequestSchema },
  branchFee: { params: IdParamsSchema, body: ServiceBranchFeeRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function reply(res: Response, record: Parameters<typeof toServiceResponse>[0], status = 200): void {
  const body: Service = toServiceResponse(record);
  res.status(status).json(body);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    req.staff!.branchId,
    { q: query.q || undefined, statuses: policy.statusesFor(query.status) },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: ServiceListResponse = {
    items: result.items.map(toServiceResponse),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  reply(res, await service.getById(valid(req, schemas.byId).params.id, req.staff!.branchId));
}

export async function create(req: Request, res: Response): Promise<void> {
  reply(res, await service.create(actor(req), valid(req, schemas.create).body), 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.update);
  reply(res, await service.update(actor(req), params.id, body));
}

export function transition(action: LifecycleAction) {
  return async (req: Request, res: Response): Promise<void> => {
    reply(res, await service.transition(actor(req), valid(req, schemas.byId).params.id, action));
  };
}

export async function setBranchFee(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.branchFee);
  reply(res, await service.setBranchFee(actor(req), params.id, body.fee));
}

export async function removeBranchFee(req: Request, res: Response): Promise<void> {
  reply(res, await service.removeBranchFee(actor(req), valid(req, schemas.byId).params.id));
}
