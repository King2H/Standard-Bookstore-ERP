import type { Request, Response } from 'express';
import {
  CreatePaymentRequestSchema,
  IdParamsSchema,
  Money,
  PaymentListQuerySchema,
  RefundPaymentRequestSchema,
  UnpaidListQuerySchema,
  type OrderBalance,
  type OrderPaymentListResponse,
  type Payment,
  type PaymentListResponse,
  type PaymentRefund,
  type PaymentRefundListResponse,
  type UnpaidListResponse,
} from '@bms/shared';
import { hashBody, withIdempotency } from '../../lib/idempotency.js';
import { scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toBalanceResponse, toPaymentResponse, toRefundResponse, toUnpaidResponse } from './payments.mapper.js';
import * as service from './payments.service.js';
import type { Actor } from './payments.types.js';

/**
 * HTTP side of order payments (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: PaymentListQuerySchema },
  unpaid: { query: UnpaidListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreatePaymentRequestSchema },
  refund: { params: IdParamsSchema, body: RefundPaymentRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

export async function listUnpaid(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.unpaid);
  const result = await service.listUnpaid(
    { branchId: scopedBranch(req), customerId: query.customerId, entityId: query.entityId, sourceType: query.sourceType },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: UnpaidListResponse = {
    items: result.items.map(toUnpaidResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    {
      branchId: scopedBranch(req),
      orderId: query.orderId,
      status: query.status,
      paymentMethod: query.paymentMethod,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: PaymentListResponse = {
    items: result.items.map(toPaymentResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const body: Payment = toPaymentResponse(await service.getById(String(valid(req, schemas.byId).params.id)));
  res.json(body);
}

/** With an Idempotency-Key header, a repeated request returns the first one's payment. */
export async function create(req: Request, res: Response): Promise<void> {
  const input = valid(req, schemas.create).body;
  const record = () =>
    service.createPayment(actor(req), {
      orderId: String(input.orderId),
      amount: Money.of(input.amount),
      paymentMethod: input.paymentMethod,
      transactionReference: input.transactionReference ?? null,
      notes: input.notes ?? null,
      bankAccountId: input.bankAccountId ?? null,
    }).then(toPaymentResponse);

  const key = req.headers['idempotency-key'];
  if (typeof key === 'string' && key) {
    const { result, replayed } = await withIdempotency(key, '/payments', hashBody(input), record);
    if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
    const body: Payment = result;
    res.status(replayed ? 200 : 201).json(body);
    return;
  }
  const body: Payment = await record();
  res.status(201).json(body);
}

export async function refund(req: Request, res: Response): Promise<void> {
  const { params, body: input } = valid(req, schemas.refund);
  const body: PaymentRefund = toRefundResponse(
    await service.refund(actor(req), String(params.id), {
      refundAmount: Money.of(input.refundAmount),
      reason: input.reason,
      bankAccountId: input.bankAccountId ?? null,
    }),
  );
  res.status(201).json(body);
}

export async function refundsOf(req: Request, res: Response): Promise<void> {
  const payment = await service.getById(String(valid(req, schemas.byId).params.id));
  const body: PaymentRefundListResponse = { items: (payment.refunds ?? []).map(toRefundResponse) };
  res.json(body);
}

export async function listByOrder(req: Request, res: Response): Promise<void> {
  const payments = await service.listByOrder(String(valid(req, schemas.byId).params.id));
  const body: OrderPaymentListResponse = { items: payments.map(toPaymentResponse) };
  res.json(body);
}

export async function orderBalance(req: Request, res: Response): Promise<void> {
  const body: OrderBalance = toBalanceResponse(await service.getOrderBalance(String(valid(req, schemas.byId).params.id)));
  res.json(body);
}
