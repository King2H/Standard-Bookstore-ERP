import type { Request, Response } from 'express';
import {
  CreateExchangeRequestSchema,
  ExchangeListQuerySchema,
  IdParamsSchema,
  Money,
  VoidExchangeRequestSchema,
  type CreateExchangeRequest,
  type Exchange,
  type ExchangeListResponse,
} from '@bms/shared';
import { hashBody, withIdempotency } from '../../lib/idempotency.js';
import { assertLocationUsable, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toExchangeResponse } from './exchanges.mapper.js';
import * as service from './exchanges.service.js';
import type { Actor, ExchangeRecord, NewExchange } from './exchanges.types.js';

/**
 * HTTP side of exchanges (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: ExchangeListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateExchangeRequestSchema },
  void: { params: IdParamsSchema, body: VoidExchangeRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function send(res: Response, record: ExchangeRecord, status = 200): void {
  const body: Exchange = toExchangeResponse(record);
  res.status(status).json(body);
}

function newExchange(req: Request, body: CreateExchangeRequest): NewExchange {
  return {
    branchId: req.staff!.branchId,
    locationId: body.locationId,
    customerId: body.customerId ?? null,
    notes: body.notes ?? null,
    incoming: body.incomingItems.map((i) => ({ bookId: i.bookId, quantity: i.quantity, unitValue: Money.of(i.unitPrice), condition: i.condition })),
    outgoing: body.outgoingItems.map((o) => ({ bookId: o.bookId, quantity: o.quantity })),
    payments: body.payments.map((p) => ({ method: p.method, amount: Money.of(p.amount), reference: p.reference ?? null })),
    allowCredit: body.allowCredit,
    dueDate: body.dueDate ?? null,
    refundMethod: body.refundMethod,
  };
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  await assertLocationUsable(req, body.locationId);
  const input = newExchange(req, body);
  // A retried request with the same Idempotency-Key gets the first answer, not a second exchange.
  const key = req.headers['idempotency-key'];
  if (typeof key === 'string' && key) {
    const { result, replayed } = await withIdempotency(key, '/exchanges', hashBody(body), async () =>
      toExchangeResponse(await service.createExchange(actor(req), input)),
    );
    if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
    res.status(replayed ? 200 : 201).json(result);
    return;
  }
  send(res, await service.createExchange(actor(req), input), 201);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    { branchId: scopedBranch(req), customerId: query.customerId, status: query.status, dateFrom: query.dateFrom, dateTo: query.dateTo },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: ExchangeListResponse = {
    items: result.items.map(toExchangeResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(String(valid(req, schemas.byId).params.id)));
}

export async function voidExchange(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.void);
  send(res, await service.voidExchange(actor(req), String(params.id), body.reason));
}

export function lifecycleRetired(): never {
  return service.lifecycleRetired();
}
