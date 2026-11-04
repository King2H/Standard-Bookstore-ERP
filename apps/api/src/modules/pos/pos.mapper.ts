import { Money, type PosTransaction } from '@bms/shared';
import { toSaleServiceLineResponse } from '../services/services.mapper.js';
import { isVoidable } from './pos.policy.js';
import type { PosLineRecord, PosPaymentRecord, PosPaymentStatus, PosTransactionRecord } from './pos.types.js';

/** The columns pos.repository selects for a sale. */
export interface PosTransactionRow {
  id: string | number | bigint;
  branch_id: number;
  location_id: number;
  customer_id: number | null;
  customer_name: string | null;
  staff_id: number;
  cashier_name: string;
  transaction_number: string;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  grand_total: string;
  amount_paid: string;
  amount_due: string;
  payment_status: string;
  currency: string;
  status: string;
  created_at: Date;
  sold_on: string;
  today: string;
  has_returns: boolean;
  due_date: string | null;
}

export interface PosLineRow {
  id: string | number | bigint;
  transaction_id: string | number | bigint;
  book_id: number;
  book_title: string | null;
  book_isbn: string | null;
  quantity: number;
  unit_price: string;
  discount_pct: string;
  discount_amount: string;
  line_total: string;
  unit_cost: string | null;
}

export interface PosPaymentRow {
  id: string | number | bigint;
  transaction_id: string | number | bigint;
  method: string;
  amount: string;
  reference: string | null;
  payer_bank: string | null;
  bank_account_id: number | null;
  cash_tendered: string | null;
  created_at: Date;
}

// The database CHECK constraints limit payment_status and status to these values.
export function toTransactionRecord(row: PosTransactionRow): PosTransactionRecord {
  return {
    id: String(row.id),
    branchId: row.branch_id,
    locationId: row.location_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    staffId: row.staff_id,
    cashierName: row.cashier_name,
    transactionNumber: row.transaction_number,
    subtotal: Money.of(row.subtotal),
    discountTotal: Money.of(row.discount_total),
    taxTotal: Money.of(row.tax_total),
    grandTotal: Money.of(row.grand_total),
    amountPaid: Money.of(row.amount_paid ?? '0'),
    amountDue: Money.of(row.amount_due ?? '0'),
    paymentStatus: (row.payment_status ?? 'paid') as PosPaymentStatus,
    currency: row.currency,
    status: row.status as 'completed' | 'voided',
    createdAt: row.created_at,
    soldOn: row.sold_on,
    today: row.today,
    hasReturns: row.has_returns,
    dueDate: row.due_date,
  };
}

export function toLineRecord(row: PosLineRow): PosLineRecord {
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    bookId: row.book_id,
    bookTitle: row.book_title ?? '',
    bookIsbn: row.book_isbn ?? '',
    quantity: row.quantity,
    unitPrice: Money.of(row.unit_price),
    discountPct: Number(row.discount_pct),
    discountAmount: Money.of(row.discount_amount),
    lineTotal: Money.of(row.line_total),
    unitCost: row.unit_cost === null ? null : Money.of(row.unit_cost),
    service: null,
  };
}

export function toPaymentRecord(row: PosPaymentRow): PosPaymentRecord {
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    method: row.method,
    amount: Money.of(row.amount),
    reference: row.reference,
    payerBank: row.payer_bank,
    bankAccountId: row.bank_account_id,
    tendered: row.cash_tendered === null ? null : Money.of(row.cash_tendered),
    createdAt: row.created_at,
  };
}

export function toTransactionResponse(t: PosTransactionRecord): PosTransaction {
  return {
    id: t.id,
    branchId: t.branchId,
    locationId: t.locationId,
    customerId: t.customerId,
    customerName: t.customerName,
    staffId: t.staffId,
    cashierName: t.cashierName,
    transactionNumber: t.transactionNumber,
    subtotal: t.subtotal.toNumber(),
    discountTotal: t.discountTotal.toNumber(),
    taxTotal: t.taxTotal.toNumber(),
    grandTotal: t.grandTotal.toNumber(),
    amountPaid: t.amountPaid.toNumber(),
    // A voided sale owes nothing: its debt was cancelled and its money handed back (#240, P9).
    amountDue: t.status === 'voided' ? 0 : t.amountDue.toNumber(),
    paymentStatus: t.paymentStatus,
    currency: t.currency,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    dueDate: t.status === 'voided' ? null : t.dueDate,
    // A started binding job keeps the sale from being voided (#169).
    voidable: isVoidable(t) && !(t.lineItems ?? []).some((l) => l.service?.job && !['REQUESTED', 'CANCELLED'].includes(l.service.job.status)),
    ...(t.lineItems && {
      lineItems: t.lineItems.map((l) => ({
        ...l,
        unitPrice: l.unitPrice.toNumber(),
        discountAmount: l.discountAmount.toNumber(),
        lineTotal: l.lineTotal.toNumber(),
        unitCost: l.unitCost?.toNumber() ?? null,
        service: l.service && toSaleServiceLineResponse(l.service),
      })),
    }),
    ...(t.payments && {
      payments: t.payments.map((p) => ({ ...p, amount: p.amount.toNumber(), tendered: p.tendered?.toNumber() ?? null, createdAt: p.createdAt.toISOString() })),
    }),
  };
}
