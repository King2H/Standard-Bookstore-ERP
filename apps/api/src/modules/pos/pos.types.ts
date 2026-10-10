import type { Money, PosPaymentMethod, PosPaymentStatus } from '@bms/shared';

export type { PosPaymentMethod, PosPaymentStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

export interface PosTransactionRecord {
  id: string;
  branchId: number;
  locationId: number;
  customerId: number | null;
  staffId: number;
  transactionNumber: string;
  subtotal: Money;
  discountTotal: Money;
  taxTotal: Money;
  grandTotal: Money;
  amountPaid: Money;
  amountDue: Money;
  paymentStatus: PosPaymentStatus;
  currency: string;
  status: 'completed' | 'voided';
  createdAt: Date;
  /** The day it was sold, YYYY-MM-DD, in the database's calendar. */
  soldOn: string;
  /** Today in the database's calendar, read with the sale. */
  today: string;
  /** A completed return refers to it. */
  hasReturns: boolean;
  dueDate: string | null;
  lineItems?: PosLineRecord[];
  payments?: PosPaymentRecord[];
}

export interface PosLineRecord {
  id: string;
  transactionId: string;
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;
  unitPrice: Money;
  discountPct: number;
  discountAmount: Money;
  lineTotal: Money;
  unitCost: Money | null;
}

export interface PosPaymentRecord {
  id: string;
  transactionId: string;
  method: string;
  amount: Money;
  reference: string | null;
  createdAt: Date;
}

export interface PaymentLine {
  method: PosPaymentMethod;
  amount: Money;
  reference: string | null;
}

export interface SaleLine {
  bookId: number;
  quantity: number;
  discountPct: number;
  discountAmount?: number;
  discountMode: 'Percentage' | 'Amount';
}

/** A sale line priced and discounted, ready to be written. */
export interface PricedLine {
  bookId: number;
  quantity: number;
  unitPrice: Money;
  discountPct: number;
  discountAmount: Money;
  lineTotal: Money;
}

export interface NewSale {
  branchId: number;
  locationId: number;
  customerId: number | null;
  items: SaleLine[];
  payments: PaymentLine[];
  allowCredit: boolean;
  dueDate: string | null;
}

export interface PosFilter {
  /** The scoped branch: sales are branch-owned (#12). */
  branchId: number;
  customerId?: number;
  staffId?: number;
  dateFrom?: string;
  dateTo?: string;
  status?: 'completed' | 'voided';
  paymentStatus?: PosPaymentStatus;
  transactionNumber?: string;
}

export type Paging = { page: number; pageSize: number };
