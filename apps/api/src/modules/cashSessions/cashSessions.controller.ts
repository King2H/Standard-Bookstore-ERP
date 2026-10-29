import type { Request, Response } from 'express';
import {
  CashMovementRequestSchema,
  CashSessionListQuerySchema,
  CloseCashSessionRequestSchema,
  IdParamsSchema,
  Money,
  OpenCashSessionRequestSchema,
  ReviewCashSessionRequestSchema,
  type CashSessionDetail,
  type CashSessionListResponse,
  type CurrentCashSessionResponse,
} from '@bms/shared';
import { scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toCashSession, toCashSessionDetail } from './cashSessions.mapper.js';
import * as service from './cashSessions.service.js';
import type { Actor, CashSessionView } from './cashSessions.types.js';

/**
 * HTTP side of cash sessions (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: CashSessionListQuerySchema },
  byId: { params: IdParamsSchema },
  open: { body: OpenCashSessionRequestSchema },
  movement: { params: IdParamsSchema, body: CashMovementRequestSchema },
  close: { params: IdParamsSchema, body: CloseCashSessionRequestSchema },
  review: { params: IdParamsSchema, body: ReviewCashSessionRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles?.length ? roles : [role], branchId };
}

function send(res: Response, session: CashSessionView, status = 200): void {
  const body: CashSessionDetail = toCashSessionDetail(session);
  res.status(status).json(body);
}

export async function current(req: Request, res: Response): Promise<void> {
  const { required, session } = await service.current(actor(req));
  const body: CurrentCashSessionResponse = { required, session: session && toCashSessionDetail(session) };
  res.json(body);
}

/** The session branch's sessions (a cashier sees their own). */
export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    actor(req),
    { branchId: scopedBranch(req), staffId: query.staffId, status: query.status, dateFrom: query.dateFrom, dateTo: query.dateTo },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: CashSessionListResponse = {
    items: result.items.map(toCashSession),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(actor(req), valid(req, schemas.byId).params.id));
}

export async function open(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.open);
  send(res, await service.open(actor(req), Money.of(body.openingFloat)), 201);
}

export async function addMovement(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.movement);
  send(
    res,
    await service.addMovement(actor(req), params.id, { direction: body.direction, category: body.category, amount: Money.of(body.amount), reason: body.reason }),
    201,
  );
}

export async function close(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.close);
  send(res, await service.close(actor(req), params.id, Money.of(body.countedCash), body.note ?? null));
}

export async function review(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.review);
  send(res, await service.review(actor(req), params.id, body.reason));
}
