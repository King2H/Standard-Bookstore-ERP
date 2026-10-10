import { Money, type Exchange } from '@bms/shared';
import type { ExchangeItemRecord, ExchangeRecord, RefundMethod, SettlementType } from './exchanges.types.js';

/** The columns exchanges.repository selects for an exchange. */
export interface ExchangeRow {
  id: string | number | bigint;
  exchange_reference: string;
  branch_id: number;
  location_id: number | null;
  customer_id: number | null;
  status: string;
  lifecycle_status: string | null;
  total_incoming_value: string;
  total_outgoing_value: string;
  net_balance: string;
  settlement_type: string;
  refund_method: string | null;
  currency: string;
  notes: string | null;
  created_by: number;
  created_at: Date;
  updated_at: Date;
  receivable_outstanding: string | null;
  receivable_status: string | null;
  due_date: string | null;
  made_on: string;
  today: string;
  voided_at: Date | null;
  voided_by: number | null;
  void_reason: string | null;
}

// The database CHECK constraints limit settlement_type and refund_method to these values.
export function toExchangeRecord(row: ExchangeRow): ExchangeRecord {
  return {
    id: String(row.id),
    exchangeReference: row.exchange_reference,
    branchId: row.branch_id,
    locationId: row.location_id,
    customerId: row.customer_id,
    status: row.status,
    lifecycleStatus: row.lifecycle_status,
    totalIncomingValue: Money.of(row.total_incoming_value),
    totalOutgoingValue: Money.of(row.total_outgoing_value),
    netBalance: Money.of(row.net_balance),
    settlementType: row.settlement_type as SettlementType,
    refundMethod: row.refund_method as RefundMethod | null,
    currency: row.currency,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    receivableOutstanding: row.receivable_outstanding === null ? null : Money.of(row.receivable_outstanding),
    receivableStatus: row.receivable_status,
    dueDate: row.due_date,
    madeOn: row.made_on,
    today: row.today,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
  };
}

/** A Quick Exchange completed today, not voided: the only kind a void undoes (owner decision 5a). */
export function isVoidable(e: Pick<ExchangeRecord, 'status' | 'lifecycleStatus' | 'madeOn' | 'today'>): boolean {
  return e.status === 'Completed' && e.lifecycleStatus === null && e.madeOn === e.today;
}

function item(i: ExchangeItemRecord) {
  return {
    id: i.id,
    exchangeId: i.exchangeId,
    bookId: i.bookId,
    bookTitle: i.bookTitle,
    quantity: i.quantity,
    unitPrice: i.unitPrice.toNumber(),
    totalPrice: i.totalPrice.toNumber(),
    ...(i.condition && { condition: i.condition }),
  };
}

export function toExchangeResponse(e: ExchangeRecord): Exchange {
  return {
    id: e.id,
    exchangeReference: e.exchangeReference,
    branchId: e.branchId,
    locationId: e.locationId,
    customerId: e.customerId,
    status: e.status,
    lifecycleStatus: e.lifecycleStatus,
    totalIncomingValue: e.totalIncomingValue.toNumber(),
    totalOutgoingValue: e.totalOutgoingValue.toNumber(),
    netBalance: e.netBalance.toNumber(),
    settlementType: e.settlementType,
    refundMethod: e.refundMethod,
    currency: e.currency,
    notes: e.notes,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    outstandingAmount: e.receivableOutstanding?.toNumber() ?? 0,
    dueDate: e.dueDate,
    settlementStatus: e.receivableStatus ?? (e.status === 'Completed' ? 'Settled' : 'Pending'),
    voidable: isVoidable(e),
    voidedAt: e.voidedAt?.toISOString() ?? null,
    voidedBy: e.voidedBy,
    voidReason: e.voidReason,
    ...(e.incomingItems && { incomingItems: e.incomingItems.map(item) }),
    ...(e.outgoingItems && { outgoingItems: e.outgoingItems.map(item) }),
    ...(e.settlementEntries && {
      settlementEntries: e.settlementEntries.map((s) => ({
        id: s.id, entryType: s.entryType, amount: s.amount.toNumber(), method: s.method, createdAt: s.createdAt.toISOString(),
      })),
    }),
  };
}
