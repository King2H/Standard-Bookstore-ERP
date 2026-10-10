import type { Request, Response } from 'express';
import {
  CollectReceivableRequestSchema,
  IdParamsSchema,
  Money,
  ReceivableDueDateRequestSchema,
  ReceivableListQuerySchema,
  WriteOffReceivableRequestSchema,
  type Receivable,
  type ReceivableListResponse,
  type ReceivableSummary,
} from '@bms/shared';
import { AppError } from '../../lib/errors.js';
import { scopedBranch, scopedBranchOrAll } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import * as paymentsService from '../payments/payments.service.js';
import * as posService from '../pos/pos.service.js';
import { toReceivableResponse, toSummaryResponse } from './receivables.mapper.js';
import * as service from './receivables.service.js';
import type { Actor } from './receivables.types.js';

/**
 * HTTP side of receivables (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: ReceivableListQuerySchema },
  byId: { params: IdParamsSchema },
  collect: { params: IdParamsSchema, body: CollectReceivableRequestSchema },
  writeOff: { params: IdParamsSchema, body: WriteOffReceivableRequestSchema },
  dueDate: { params: IdParamsSchema, body: ReceivableDueDateRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function send(res: Response, record: Parameters<typeof toReceivableResponse>[0]): void {
  const body: Receivable = toReceivableResponse(record);
  res.json(body);
}

export async function summary(req: Request, res: Response): Promise<void> {
  const body: ReceivableSummary = toSummaryResponse(await service.getSummary(scopedBranchOrAll(req)));
  res.json(body);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    {
      branchId: scopedBranch(req),
      customerId: query.customerId,
      statuses: query.status?.length ? query.status : undefined,
      overdueOnly: query.overdueOnly,
      sourceType: query.sourceType,
      dueDateFrom: query.dueDateFrom,
      dueDateTo: query.dueDateTo,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: ReceivableListResponse = {
    items: result.items.map(toReceivableResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(String(valid(req, schemas.byId).params.id)));
}

/**
 * "The customer paid", whatever opened the receivable: an order or a POS
 * sale is paid through its own payment flow, an exchange difference here.
 * Dispatching in the controller keeps receivables from importing payments
 * and POS, which import receivables.
 */
export async function collect(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.collect);
  const id = String(params.id);
  const amount = Money.of(body.amount);
  const receivable = await service.getById(id);
  if (receivable.sourceType === 'order_credit_sale') {
    await paymentsService.createPayment(actor(req), {
      orderId: receivable.sourceEntityId,
      amount,
      paymentMethod: body.paymentMethod,
      transactionReference: null,
      notes: body.notes ?? null,
      bankAccountId: body.bankAccountId ?? null,
    });
  } else if (receivable.sourceType === 'pos_credit_sale') {
    await posService.recordPayment(actor(req), receivable.sourceEntityId, [
      { method: body.paymentMethod, amount, reference: body.notes ?? null },
    ]);
  } else {
    await service.collectPayment(actor(req), id, {
      amount,
      paymentMethod: body.paymentMethod,
      bankAccountId: body.bankAccountId ?? null,
      notes: body.notes ?? null,
    });
  }
  send(res, await service.getById(id));
}

export async function writeOff(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.writeOff);
  send(res, await service.writeOff(actor(req), String(params.id), body.reason));
}

export async function changeDueDate(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.dueDate);
  send(res, await service.changeDueDate(actor(req), String(params.id), body.dueDate));
}

/** Retired (#21, owner decision): a write-off needs a reason and has its own status. */
export function settle(): never {
  throw new AppError(
    'DEPRECATED',
    'POST /receivables/{id}/settle is no longer supported. Use POST /receivables/{id}/write-off with a reason.',
    410,
  );
}
