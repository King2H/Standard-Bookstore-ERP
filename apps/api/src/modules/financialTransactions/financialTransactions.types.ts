import type { FinancialTransactionType, Money } from '@bms/shared';

/** A financial_transactions row in application form. */
export interface FinancialTransactionRecord {
  id: string;
  type: FinancialTransactionType;
  orderId: string | null;
  exchangeId: string | null;
  idempotencyKey: string;
  amount: Money;
  currency: string;
  method: string | null;
  staffId: number;
  branchId: number;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface FinancialTransactionFilter {
  /** The scoped branch: the ledger is branch-owned (#12). */
  branchId: number;
  orderId?: number;
  exchangeId?: number;
  type?: FinancialTransactionType;
}
