import { Money, type FinancialTransaction, type FinancialTransactionType } from '@bms/shared';
import type { FinancialTransactionRecord } from './financialTransactions.types.js';

/** The columns financialTransactions.repository selects. */
export interface FinancialTransactionRow {
  id: string | number | bigint;
  type: string;
  order_id: string | number | bigint | null;
  exchange_id: string | number | bigint | null;
  idempotency_key: string;
  amount: string;
  currency: string;
  method: string | null;
  staff_id: number;
  branch_id: number;
  meta: unknown;
  created_at: Date;
}

// The database CHECK constraint limits type to the three values.
export function toFinancialTransactionRecord(row: FinancialTransactionRow): FinancialTransactionRecord {
  return {
    id: String(row.id),
    type: row.type as FinancialTransactionType,
    orderId: row.order_id === null ? null : String(row.order_id),
    exchangeId: row.exchange_id === null ? null : String(row.exchange_id),
    idempotencyKey: row.idempotency_key,
    amount: Money.of(row.amount),
    currency: row.currency,
    method: row.method,
    staffId: row.staff_id,
    branchId: row.branch_id,
    meta: (row.meta as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at,
  };
}

export function toFinancialTransactionResponse(record: FinancialTransactionRecord): FinancialTransaction {
  return { ...record, amount: record.amount.toNumber(), createdAt: record.createdAt.toISOString() };
}
