import type { Money, OrderPaymentMethod, PaymentStatus } from '@bms/shared';

export type { OrderPaymentMethod, PaymentStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

/** What a payment or refund needs to know about its order, read under lock. */
export interface OrderForPayment {
  id: string;
  orderNumber: string;
  branchId: number;
  status: string;
  saleType: string;
  total: Money | null;
  customerId: number | null;
  paymentStatus: string;
}

/** An order's money so far. */
export interface OrderTakings {
  /** Every successful payment, refunded or not. */
  paid: Money;
  refunded: Money;
}

export interface PaymentRecord {
  id: string;
  paymentReference: string;
  orderId: string;
  amount: Money;
  currency: string;
  paymentMethod: string;
  status: PaymentStatus;
  transactionReference: string | null;
  notes: string | null;
  processedAt: Date;
  createdAt: Date;
  processedBy: number;
  bankAccountId: number | null;
  refunds?: RefundRecord[];
  sourceType?: string;
  entityNumber?: string;
  orderStatus?: string | null;
}

export interface RefundRecord {
  id: string;
  paymentId: string;
  orderId: string;
  refundAmount: Money;
  reason: string;
  method: string | null;
  bankAccountId: number | null;
  processedBy: number;
  createdAt: Date;
}

export interface NewPayment {
  orderId: string;
  amount: Money;
  paymentMethod: OrderPaymentMethod;
  transactionReference: string | null;
  notes: string | null;
  bankAccountId: number | null;
}

export interface NewRefund {
  refundAmount: Money;
  reason: string;
  bankAccountId: number | null;
}

export interface PaymentFilter {
  /** The scoped branch: payments belong to their order's, sale's or exchange's branch (#12). */
  branchId: number;
  orderId?: number;
  status?: PaymentStatus;
  paymentMethod?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface UnpaidFilter {
  branchId: number;
  customerId?: number;
  entityId?: string;
  sourceType?: 'order' | 'pos' | 'exchange_difference';
}

export interface UnpaidRecord {
  id: string;
  orderNumber: string;
  customerName: string | null;
  customerCode: string | null;
  total: Money;
  totalPaid: Money;
  outstanding: Money;
  paymentStatus: string;
  status: string;
  channel: string;
  createdAt: Date;
  sourceType: 'order' | 'pos' | 'exchange_difference';
}

export interface OrderBalanceRecord {
  orderTotal: Money;
  totalPaid: Money;
  totalRefunded: Money;
  outstanding: Money;
  paymentStatus: string;
}

export type Paging = { page: number; pageSize: number };
