import type { Money, RefundMethod } from '@bms/shared';

export type { RefundMethod };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  /** Every role held in the session branch (location limits look at all of them). */
  roles: string[];
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

/** The delivered customer order a return is made against, read under lock (#166). */
export interface OrderForReturn {
  id: string;
  branchId: number;
  customerId: number | null;
  status: string;
  orderNumber: string;
  saleType: 'cash_sale' | 'credit_sale';
  /** Where the order's stock left from: the returned books go back there. */
  locationId: number | null;
  /** Whole days since delivery, in the database's calendar; null when never delivered. */
  daysSinceDelivery: number | null;
}

/** A line of the sale or order, with what earlier returns already took back from it. */
export interface SaleLine {
  id: string;
  bookId: number;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
  unitCost: Money | null;
  returnedQuantity: number;
  returnedValue: Money;
  /** Copies handed over so far, where fewer than sold may come back: a part-delivered order (#174). */
  deliveredQuantity?: number;
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
  /** The line of the sale or order the return names. */
  lineId: number;
  quantity: number;
  disposition: 'SELLABLE' | 'DAMAGED';
  /** Bound copies brought back defective (#169 PR 3); a bound copy comes back no other way. */
  defective?: boolean;
}

/** An exchange a binding fee comes back from (#169 PR 4). */
export interface ExchangeForReturn {
  id: string;
  branchId: number;
  locationId: number | null;
  customerId: number | null;
  reference: string;
  voided: boolean;
}

export interface ReturnRecord {
  id: string;
  returnNumber: string;
  transactionId: string | null;
  transactionNumber: string | null;
  orderId: string | null;
  orderNumber: string | null;
  /** The exchange whose binding fee came back (#169 PR 4). */
  exchangeId: string | null;
  exchangeReference: string | null;
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
  transactionLineItemId: string | null;
  orderLineItemId: string | null;
  exchangeLineItemId: string | null;
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
  orderId?: number;
  status?: 'completed' | 'rejected';
  dateFrom?: string;
  dateTo?: string;
}

export type Paging = { page: number; pageSize: number };
