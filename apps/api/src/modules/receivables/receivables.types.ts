import type { Money, ReceivableSourceType, ReceivableStatus } from '@bms/shared';

export type { ReceivableSourceType, ReceivableStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

/** A receivables row in application form. */
export interface ReceivableRecord {
  id: string;
  sourceType: ReceivableSourceType;
  sourceRefId: string;
  sourceEntityId: string;
  customerId: number;
  customerName: string | null;
  customerCode: string | null;
  branchId: number;
  originalAmount: Money;
  outstandingAmount: Money;
  currency: string;
  /** YYYY-MM-DD. */
  dueDate: string | null;
  settlementDate: Date | null;
  status: ReceivableStatus;
  notes: string | null;
  writtenOffAmount: Money | null;
  writtenOffAt: Date | null;
  writtenOffBy: number | null;
  writeOffReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a sale or exchange opens when the customer leaves owing money. */
export interface NewReceivable {
  sourceType: ReceivableSourceType;
  /** The sale's or exchange's number. */
  sourceRefId: string;
  sourceEntityId: number;
  customerId: number;
  branchId: number;
  originalAmount: Money;
  /** YYYY-MM-DD. */
  dueDate: string | null;
  notes: string | null;
}

export interface ReceivableFilter {
  /** The scoped branch: receivables are branch-owned (#12). */
  branchId: number;
  customerId?: number;
  /** Undefined means any status. */
  statuses?: ReceivableStatus[];
  overdueOnly?: boolean;
  sourceType?: ReceivableSourceType;
  dueDateFrom?: string;
  dueDateTo?: string;
}

export interface ReceivableSummaryRecord {
  totalOutstanding: Money;
  pendingCount: number;
  overdueCount: number;
  partiallyPaidCount: number;
  settledThisMonth: number;
  writtenOffThisMonth: number;
}

export interface PaymentCollection {
  amount: Money;
  paymentMethod: 'cash' | 'bank' | 'mobile' | 'store_credit';
  bankAccountId: number | null;
  notes: string | null;
}

export type Paging = { page: number; pageSize: number };
