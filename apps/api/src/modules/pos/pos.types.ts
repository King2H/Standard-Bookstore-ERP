import type { Money, PosPaymentMethod, PosPaymentStatus, ServiceLineInput } from '@bms/shared';
import type { DiscountMode, DiscountType } from '../../lib/discount.js';
import type { SaleServiceLineRecord } from '../services/services.types.js';

export type { PosPaymentMethod, PosPaymentStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  /** Every role held in the session branch; the main role when not given. */
  roles?: string[];
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
  /** The service on the line's copies (#169), filled in on a single sale. */
  service: SaleServiceLineRecord | null;
}

export interface PosPaymentRecord {
  id: string;
  transactionId: string;
  method: string;
  amount: Money;
  reference: string | null;
  payerBank: string | null;
  bankAccountId: number | null;
  createdAt: Date;
}

export interface PaymentLine {
  method: PosPaymentMethod;
  amount: Money;
  reference: string | null;
  payerBank: string | null;
  bankAccountId?: number | null;
}

export interface SaleLine {
  bookId: number;
  quantity: number;
  discountPct: number;
  discountAmount?: number;
  discountMode: DiscountMode;
  /** The preset the cashier picked; reports break discounts down by it. */
  discountType: DiscountType;
  /** A service on some or all of the line's copies (#169). */
  service?: ServiceLineInput;
}

/** A sale line priced and discounted, ready to be written. */
export interface PricedLine {
  bookId: number;
  quantity: number;
  unitPrice: Money;
  discountPct: number;
  discountAmount: Money;
  discountMode: DiscountMode;
  discountType: DiscountType;
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
