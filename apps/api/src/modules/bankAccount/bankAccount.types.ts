import type { Money } from '@bms/shared';

/** Records the bank account module passes between its layers (#21). */

export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

export interface BankAccountRecord {
  id: number;
  branchId: number;
  accountName: string;
  bankName: string;
  /** Encrypted; masked before it leaves the API. */
  accountNumber: string;
  iban: string | null;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  hasMovements: boolean;
}

export type Direction = 'in' | 'out';

/** Where a bank movement came from; each source records at most one movement. */
export type BankSourceType =
  | 'order_payment'
  | 'order_refund'
  | 'receivable_payment'
  | 'pos_payment'
  | 'pos_void'
  | 'return_refund'
  | 'exchange_payment'
  | 'exchange_void'
  | 'supplier_payment'
  // Money a supplier pays back after a return (#173).
  | 'supplier_refund';

/** A bank movement the system recorded (bank_reconciliation). */
export interface BankEntryRecord {
  id: string;
  bankAccountId: number;
  sourceType: string;
  sourceId: string;
  amount: Money;
  direction: Direction;
  status: 'uncleared' | 'cleared';
  notes: string | null;
  createdAt: Date;
  /** YYYY-MM-DD, for matching against statement dates. */
  madeOn: string;
}

export interface StatementLineRecord {
  id: string;
  bankAccountId: number;
  statementDate: string;
  amount: Money;
  direction: Direction;
  reference: string | null;
  description: string | null;
  entryId: string | null;
  matchedAt: Date | null;
  importedAt: Date;
}

export interface NewStatementLine {
  statementDate: string;
  amount: Money;
  direction: Direction;
  reference: string | null;
  description: string | null;
}

export interface BankMovement {
  bankAccountId: number;
  direction: Direction;
  amount: Money;
  sourceType: BankSourceType;
  sourceId: string;
  notes: string | null;
}
