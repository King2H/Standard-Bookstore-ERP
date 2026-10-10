import type { Request, Response } from 'express';
import {
  CreateSupplierCreditNoteRequestSchema,
  CreateSupplierPaymentRequestSchema,
  IdParamsSchema,
  Money,
  ReverseSupplierPaymentRequestSchema,
  SupplierLedgerQuerySchema,
  SupplierPaymentParamsSchema,
  type PurchaseOrder,
  type SupplierLedgerResponse,
} from '@bms/shared';
import { buildCsv, sendCsv, SUPPLIER_LEDGER_COLUMNS } from '../../lib/csvBuilder.js';
import { scopedBranchOrAll } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toPurchaseOrderResponse } from './procurement.mapper.js';
import type { Actor, PurchaseOrderRecord } from './procurement.types.js';
import * as service from './supplierPayables.service.js';

/**
 * HTTP side of supplier payables (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  payment: { params: IdParamsSchema, body: CreateSupplierPaymentRequestSchema },
  reverse: { params: SupplierPaymentParamsSchema, body: ReverseSupplierPaymentRequestSchema },
  creditNote: { params: IdParamsSchema, body: CreateSupplierCreditNoteRequestSchema },
  ledger: { params: IdParamsSchema, query: SupplierLedgerQuerySchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function send(res: Response, record: PurchaseOrderRecord, status = 200): void {
  const body: PurchaseOrder = toPurchaseOrderResponse(record);
  res.status(status).json(body);
}

export async function recordPayment(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.payment);
  const record = await service.recordPayment(actor(req), String(params.id), {
    amount: Money.of(body.amount),
    paymentMethod: body.paymentMethod,
    notes: body.notes ?? null,
  });
  send(res, record, 201);
}

export async function reversePayment(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.reverse);
  send(res, await service.reversePayment(actor(req), String(params.id), params.paymentId, body.reason));
}

export async function recordCreditNote(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.creditNote);
  send(res, await service.recordCreditNote(actor(req), String(params.id), { amount: Money.of(body.amount), reason: body.reason }), 201);
}

async function ledgerOf(req: Request): Promise<SupplierLedgerResponse> {
  const { params, query } = valid(req, schemas.ledger);
  const result = await service.ledger(params.id, scopedBranchOrAll(req), { dateFrom: query.dateFrom, dateTo: query.dateTo });
  return {
    entries: result.entries.map((e) => ({
      date: e.day,
      type: e.type,
      reference: e.reference,
      description: e.description,
      amount: e.amount.toNumber(),
      balance: e.balance.toNumber(),
    })),
    currentBalance: result.currentBalance.toNumber(),
  };
}

export async function ledger(req: Request, res: Response): Promise<void> {
  res.json(await ledgerOf(req));
}

export async function exportLedger(req: Request, res: Response): Promise<void> {
  const { entries } = await ledgerOf(req);
  const today = new Date().toISOString().slice(0, 10);
  sendCsv(res, `supplier-ledger-${today}.csv`, buildCsv(entries, SUPPLIER_LEDGER_COLUMNS));
}
