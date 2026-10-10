import { Money, type Return } from '@bms/shared';
import type { RefundMethod, RefundRecord, ReturnLineRecord, ReturnRecord } from './returns.types.js';

/** The columns returns.repository selects. */
export interface ReturnRow {
  id: string | number | bigint;
  return_number: string;
  transaction_id: string | number | bigint;
  branch_id: number;
  customer_id: number | null;
  total_refund_amount: string;
  refund_method: string;
  status: string;
  reason: string | null;
  processed_by: number;
  approved_by: number | null;
  created_at: Date;
}

export interface ReturnLineRow {
  id: string | number | bigint;
  return_id: string | number | bigint;
  transaction_line_item_id: string | number | bigint;
  book_id: number;
  book_title: string | null;
  quantity: number;
  unit_price: string;
  line_refund_amount: string;
}

export interface RefundRow {
  id: string | number | bigint;
  return_id: string | number | bigint;
  method: string;
  amount: string;
  created_at: Date;
}

// The database CHECK constraints limit refund_method, method and status to these values.
export function toReturnRecord(row: ReturnRow): ReturnRecord {
  return {
    id: String(row.id),
    returnNumber: row.return_number,
    transactionId: String(row.transaction_id),
    branchId: row.branch_id,
    customerId: row.customer_id,
    totalRefundAmount: Money.of(row.total_refund_amount),
    refundMethod: row.refund_method as ReturnRecord['refundMethod'],
    status: row.status as ReturnRecord['status'],
    reason: row.reason,
    processedBy: row.processed_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
  };
}

export function toLineRecord(row: ReturnLineRow): ReturnLineRecord {
  return {
    id: String(row.id),
    returnId: String(row.return_id),
    transactionLineItemId: String(row.transaction_line_item_id),
    bookId: row.book_id,
    bookTitle: row.book_title ?? '',
    quantity: row.quantity,
    unitPrice: Money.of(row.unit_price),
    lineRefundAmount: Money.of(row.line_refund_amount),
  };
}

export function toRefundRecord(row: RefundRow): RefundRecord {
  return {
    id: String(row.id),
    returnId: String(row.return_id),
    method: row.method as RefundMethod,
    amount: Money.of(row.amount),
    createdAt: row.created_at,
  };
}

export function toReturnResponse(r: ReturnRecord): Return {
  const { lineItems, refunds, ...head } = r;
  return {
    ...head,
    totalRefundAmount: r.totalRefundAmount.toNumber(),
    createdAt: r.createdAt.toISOString(),
    ...(lineItems && {
      lineItems: lineItems.map((l) => ({ ...l, unitPrice: l.unitPrice.toNumber(), lineRefundAmount: l.lineRefundAmount.toNumber() })),
    }),
    ...(refunds && {
      refunds: refunds.map((x) => ({ ...x, amount: x.amount.toNumber(), createdAt: x.createdAt.toISOString() })),
    }),
  };
}
