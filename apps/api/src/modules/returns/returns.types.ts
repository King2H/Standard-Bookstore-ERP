import type { Money, RefundMethod } from '@bms/shared';

export type { RefundMethod };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

/** The sale a return is made against, read under lock. */
export interface SaleForReturn {
  id: string;
  branchId: number;
  locationId: number;
  customerId: number | null;
  status: 'completed' | 'voided';
  transactionNumber: string;
  subtotal: Money;
  grandTotal: Money;
  amountPaid: Money;
  amountDue: Money;
  /** Whole days since the sale, in the database's calendar. */
  daysSinceSale: number;
}

/** A line of the sale, with what earlier returns already took back from it. */
export interface SaleLine {
  id: string;
  bookId: number;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  unitCost: Money | null;
  returnedQuantity: number;
  returnedValue: Money;
}

/** What one payment method of the sale can still give back. */
export interface Tender {
  method: Exclude<RefundMethod, 'credit_note'>;
  available: Money;
  /** When this method was last used on the sale; the newest is refunded first. */
  lastPaidAt: Date;
}

export interface RefundPart {
  method: RefundMethod;
  amount: Money;
}

export interface ReturnLineRequest {
  transactionLineItemId: number;
  quantity: number;
  disposition: 'SELLABLE' | 'DAMAGED';
}

export interface ReturnRecord {
  id: string;
  returnNumber: string;
  transactionId: string;
  branchId: number;
  customerId: number | null;
  totalRefundAmount: Money;
  refundMethod: RefundMethod | 'mixed';
  status: 'completed' | 'rejected';
  reason: string | null;
  processedBy: number;
  approvedBy: number | null;
  createdAt: Date;
  lineItems?: ReturnLineRecord[];
  refunds?: RefundRecord[];
}

export interface ReturnLineRecord {
  id: string;
  returnId: string;
  transactionLineItemId: string;
  bookId: number;
  bookTitle: string;
  quantity: number;
  unitPrice: Money;
  lineRefundAmount: Money;
}

export interface RefundRecord {
  id: string;
  returnId: string;
  method: RefundMethod;
  amount: Money;
  createdAt: Date;
}

export interface ReturnFilter {
  /** The scoped branch: returns are branch-owned (#12). */
  branchId: number;
  customerId?: number;
  transactionId?: number;
  status?: 'completed' | 'rejected';
  dateFrom?: string;
  dateTo?: string;
}

export type Paging = { page: number; pageSize: number };
