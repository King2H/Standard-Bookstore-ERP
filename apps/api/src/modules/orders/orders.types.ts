import type { OrderDelivery, SaleServiceLine, ServiceLineInput } from '@bms/shared';
import type { DiscountMode, DiscountType } from '../../lib/discount.js';

export interface StaffCtx { staffId: number; role: string; roles?: string[]; branchId: number; }

/** How a cash order is paid at confirmation; a bank or Telebirr payment carries its proof. */
export interface ConfirmPayment {
  method: string | null;
  transactionReference: string | null;
  payerBank: string | null;
  bankAccountId: number | null;
}

export type SaleType = 'cash_sale' | 'credit_sale';

/** The values the orders.payment_status constraint allows. */
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

export interface OrderLineInput {
  bookId: number;
  quantity: number;
  /** Legacy plain override — used when discountMode is absent or 'Amount' */
  discountAmount?: number;
  /** Percentage 0–100 (used when discountMode = 'Percentage') */
  discountPct?: number;
  discountType?: DiscountType;
  discountMode?: DiscountMode;
  /** A service on some or all of the line's copies (#169). */
  service?: ServiceLineInput;
}

export interface OrderRow {
  id: string; orderNumber: string; customerId: number | null; branchId: number;
  locationId: number | null; channel: string; status: string; paymentStatus: string;
  /** Payments taken less refunds (#167). */
  amountPaid: number;
  saleType: SaleType;
  currency: string; subtotal: number; discountAmount: number; discountTotal: number;
  taxRate: number; taxAmount: number; total: number;
  cancelReason: string | null; notes: string | null;
  createdBy: number; createdAt: string; updatedAt: string; lineItems?: OrderLineItemRow[];
  allowedActions?: string[];
  /** Payment method recorded for this order (cash orders: at confirm). */
  paymentMethod?: string | null;
  /** Credit sale due date (YYYY-MM-DD), from the linked receivable. */
  dueDate?: string | null;
  /** When the goods were handed over (#166). */
  fulfilledAt: string | null;
  /** False while a binding job is not ready: the order waits for it (#169). */
  jobsReady?: boolean;
  /** Its deliveries (#174), on a single order. */
  deliveries?: OrderDelivery[];
}

export interface OrderLineItemRow {
  id: string; orderId: string; bookId: number; bookTitle: string; bookIsbn: string;
  quantity: number; unitPrice: number; discountAmount: number; totalPrice: number;
  discountType: 'Normal' | 'Merchant' | 'Special'; discountMode: 'Percentage' | 'Amount'; discountPct: number;
  qtyReserved: number; qtyFulfilled: number; isBackordered: boolean;
  /** Cost this line was posted at (Weighted Average Cost at confirm() time). Null until confirmed, or for pre-migration rows. */
  unitCost: number | null;
  /** Copies brought back through Returns (#166). */
  qtyReturned: number;
  /** Copies never delivered, cancelled with the rest of the order (#174). */
  qtyCancelled: number;
  /** The service on the line's copies (#169). */
  service: SaleServiceLine | null;
}

/** A priced line, ready to insert. Amounts are decimal strings, as stored. */
export interface PricedLine {
  bookId: number;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  discountPct: number;
  discountType: DiscountType;
  discountMode: DiscountMode;
  totalPrice: string;
}

export interface OrderTotals {
  subtotal: string;
  discountTotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
}
