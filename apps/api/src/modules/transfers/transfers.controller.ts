import type { Request, Response } from 'express';
import {
  IdParamsSchema,
  ReceiveTransferRequestSchema,
  ResolveTransferRequestSchema,
  TransferListQuerySchema,
  TransferRequestSchema,
  type Transfer,
  type TransferListResponse,
  type TransferRequest,
} from '@bms/shared';
import { assertLocationUsable, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toTransferResponse, toTransferSummary } from './transfers.mapper.js';
import * as service from './transfers.service.js';
import type { Actor, NewTransfer, TransferView } from './transfers.types.js';

/**
 * HTTP side of transfers between branches (A3): validated request -> service
 * -> response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: TransferListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: TransferRequestSchema },
  update: { params: IdParamsSchema, body: TransferRequestSchema },
  receive: { params: IdParamsSchema, body: ReceiveTransferRequestSchema },
  resolve: { params: IdParamsSchema, body: ResolveTransferRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles?.length ? roles : [role], branchId };
}

function send(res: Response, record: TransferView, status = 200): void {
  const body: Transfer = toTransferResponse(record);
  res.status(status).json(body);
}

const idOf = (req: Request) => valid(req, schemas.byId).params.id;

/** The source is a location of the session's branch the staff member may use (#72). */
async function draftOf(req: Request, body: TransferRequest): Promise<NewTransfer> {
  await assertLocationUsable(req, body.fromLocationId);
  return { fromLocationId: body.fromLocationId, toBranchId: body.toBranchId, lines: body.lines, notes: body.notes ?? null };
}

/** The session's branch's notes, sent or received (another branch only with access to all branches). */
export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    { branchId: scopedBranch(req), direction: query.direction, status: query.status },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: TransferListResponse = {
    items: result.items.map(toTransferSummary),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(idOf(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  send(res, await service.create(actor(req), await draftOf(req, body)), 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.update);
  send(res, await service.update(actor(req), params.id, await draftOf(req, body)));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  send(res, await service.cancel(actor(req), idOf(req)));
}

export async function dispatch(req: Request, res: Response): Promise<void> {
  send(res, await service.dispatch(actor(req), idOf(req)));
}

export async function receive(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.receive);
  await assertLocationUsable(req, body.locationId);
  send(res, await service.receive(actor(req), params.id, { locationId: body.locationId, items: body.items, notes: body.notes ?? null }));
}

export async function resolve(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.resolve);
  await assertLocationUsable(req, body.locationId ?? null);
  send(
    res,
    await service.resolve(actor(req), params.id, {
      lineId: body.lineId,
      outcome: body.outcome,
      quantity: body.quantity,
      reason: body.reason,
      locationId: body.locationId ?? null,
    }),
  );
}
