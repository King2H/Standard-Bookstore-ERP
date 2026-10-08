import type { DiscountMode, DiscountType } from '../../lib/discount.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

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
}

export interface OrderRow {
  id: string; orderNumber: string; customerId: number | null; branchId: number;
  locationId: number | null; channel: string; status: string; paymentStatus: string;
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
}

export interface OrderLineItemRow {
  id: string; orderId: string; bookId: number; bookTitle: string; bookIsbn: string;
  quantity: number; unitPrice: number; discountAmount: number; totalPrice: number;
  qtyReserved: number; qtyFulfilled: number; isBackordered: boolean;
  /** Cost this line was posted at (Weighted Average Cost at confirm() time). Null until confirmed, or for pre-migration rows. */
  unitCost: number | null;
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
