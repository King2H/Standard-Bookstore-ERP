import type { Request, Response } from 'express';
import {
  CreatePosTransactionRequestSchema,
  IdParamsSchema,
  Money,
  PosCollectRequestSchema,
  PosTransactionListQuerySchema,
  type PosPaymentInput,
  type PosTransaction,
  type PosTransactionListResponse,
} from '@bms/shared';
import { assertLocationUsable, bookingBranch, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toTransactionResponse } from './pos.mapper.js';
import * as service from './pos.service.js';
import type { Actor, PaymentLine } from './pos.types.js';

/**
 * HTTP side of counter sales (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: PosTransactionListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreatePosTransactionRequestSchema },
  collect: { params: IdParamsSchema, body: PosCollectRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function paymentLines(payments: PosPaymentInput[]): PaymentLine[] {
  return payments.map((p) => ({ method: p.method, amount: Money.of(p.amount), reference: p.reference ?? null }));
}

function send(res: Response, record: Parameters<typeof toTransactionResponse>[0], status = 200): void {
  const body: PosTransaction = toTransactionResponse(record);
  res.status(status).json(body);
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  await assertLocationUsable(req, body.locationId);
  const record = await service.createTransaction(actor(req), {
    branchId: bookingBranch(req, body.branchId),
    locationId: body.locationId,
    customerId: body.customerId ?? null,
    items: body.items.map((i) => ({
      bookId: i.bookId,
      quantity: i.quantity,
      discountPct: i.discountPct ?? 0,
      discountAmount: i.discountAmount,
      discountMode: i.discountMode ?? 'Percentage',
    })),
    payments: paymentLines(body.payments),
    allowCredit: body.allowCredit,
    dueDate: body.dueDate ?? null,
  });
  send(res, record, 201);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    {
      branchId: scopedBranch(req),
      customerId: query.customerId,
      staffId: query.staffId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      status: query.status,
      paymentStatus: query.paymentStatus,
      transactionNumber: query.transactionNumber,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: PosTransactionListResponse = {
    items: result.items.map(toTransactionResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(String(valid(req, schemas.byId).params.id)));
}

export async function collect(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.collect);
  send(res, await service.recordPayment(actor(req), String(params.id), paymentLines(body.payments)));
}

export async function voidTransaction(req: Request, res: Response): Promise<void> {
  send(res, await service.voidTransaction(actor(req), String(valid(req, schemas.byId).params.id)));
}
