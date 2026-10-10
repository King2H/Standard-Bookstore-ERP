import { Money, type OrderBalance, type Payment, type PaymentRefund, type PaymentStatus, type UnpaidItem } from '@bms/shared';
import type { OrderBalanceRecord, PaymentRecord, RefundRecord, UnpaidRecord } from './payments.types.js';

/** The columns payments.repository selects for a payment (and history rows). */
export interface PaymentRow {
  id: string | number | bigint;
  payment_reference: string;
  order_id: string | number | bigint;
  amount: string;
  currency: string;
  payment_method: string;
  status: string;
  transaction_reference: string | null;
  notes: string | null;
  processed_at: Date;
  created_at: Date;
  processed_by: number;
  bank_account_id: number | null;
  source_type?: string;
  entity_number?: string;
  order_status?: string | null;
}

export interface RefundRow {
  id: string | number | bigint;
  payment_id: string | number | bigint;
  order_id: string | number | bigint;
  refund_amount: string;
  reason: string;
  method: string | null;
  bank_account_id: number | null;
  processed_by: number;
  created_at: Date;
}

export interface UnpaidRow {
  id: string;
  order_number: string;
  customer_name: string | null;
  customer_code: string | null;
  total: string;
  total_paid: string;
  payment_status: string;
  status: string;
  channel: string;
  created_at: Date;
  source_type: UnpaidRecord['sourceType'];
}

// The database CHECK constraint limits status to the PaymentStatus values.
export function toPaymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: String(row.id),
    paymentReference: row.payment_reference,
    orderId: String(row.order_id),
    amount: Money.of(row.amount),
    currency: row.currency,
    paymentMethod: row.payment_method,
    status: row.status as PaymentStatus,
    transactionReference: row.transaction_reference,
    notes: row.notes,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    processedBy: row.processed_by,
    bankAccountId: row.bank_account_id,
    ...(row.source_type !== undefined && { sourceType: row.source_type }),
    ...(row.entity_number !== undefined && { entityNumber: row.entity_number }),
    ...(row.order_status !== undefined && { orderStatus: row.order_status }),
  };
}

export function toRefundRecord(row: RefundRow): RefundRecord {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    orderId: String(row.order_id),
    refundAmount: Money.of(row.refund_amount),
    reason: row.reason,
    method: row.method,
    bankAccountId: row.bank_account_id,
    processedBy: row.processed_by,
    createdAt: row.created_at,
  };
}

export function toUnpaidRecord(row: UnpaidRow): UnpaidRecord {
  const total = Money.of(row.total);
  const totalPaid = Money.of(row.total_paid);
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerName: row.customer_name,
    customerCode: row.customer_code,
    total,
    totalPaid,
    outstanding: Money.max(0, total.minus(totalPaid)),
    paymentStatus: row.payment_status,
    status: row.status,
    channel: row.channel,
    createdAt: row.created_at,
    sourceType: row.source_type,
  };
}

export function toRefundResponse(r: RefundRecord): PaymentRefund {
  return { ...r, refundAmount: r.refundAmount.toNumber(), createdAt: r.createdAt.toISOString() };
}

export function toPaymentResponse({ refunds, ...p }: PaymentRecord): Payment {
  return {
    ...p,
    amount: p.amount.toNumber(),
    processedAt: p.processedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    ...(refunds && { refunds: refunds.map(toRefundResponse) }),
  };
}

export function toUnpaidResponse(u: UnpaidRecord): UnpaidItem {
  return {
    ...u,
    total: u.total.toNumber(),
    totalPaid: u.totalPaid.toNumber(),
    outstanding: u.outstanding.toNumber(),
    createdAt: u.createdAt.toISOString(),
  };
}

export function toBalanceResponse(b: OrderBalanceRecord): OrderBalance {
  return {
    orderTotal: b.orderTotal.toNumber(),
    totalPaid: b.totalPaid.toNumber(),
    totalRefunded: b.totalRefunded.toNumber(),
    outstanding: b.outstanding.toNumber(),
    paymentStatus: b.paymentStatus,
  };
}
