import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, MoneyInputSchema } from './common.js';

/** Contracts for /api/v1/payments and an order's payments and balance (#21). */

export const OrderPaymentMethodSchema = z.enum(['cash', 'bank', 'mobile', 'card', 'store_credit', 'loyalty_points', 'other']);
export type OrderPaymentMethod = z.infer<typeof OrderPaymentMethodSchema>;

export const PaymentStatusSchema = z.enum(['pending', 'success', 'failed', 'refunded', 'partially_refunded']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentRefundSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  orderId: z.string(),
  refundAmount: z.number(),
  reason: z.string(),
  /** Back the way it was paid: the payment's method. */
  method: z.string().nullable(),
  bankAccountId: z.number().int().nullable(),
  processedBy: z.number().int(),
  createdAt: z.string(),
});
export type PaymentRefund = z.infer<typeof PaymentRefundSchema>;

export const PaymentSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  /** PAY-YYYYMMDD-NNNN for order payments. */
  paymentReference: z.string(),
  /** The order's id; for history rows of a POS sale or exchange, theirs. */
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  paymentMethod: z.string(),
  status: PaymentStatusSchema,
  transactionReference: z.string().nullable(),
  notes: z.string().nullable(),
  processedAt: z.string(),
  createdAt: z.string(),
  processedBy: z.number().int(),
  bankAccountId: z.number().int().nullable(),
  /** On a single payment only. */
  refunds: z.array(PaymentRefundSchema).optional(),
  /** In history: order, pos or exchange. */
  sourceType: z.string().optional(),
  /** In history: the order, sale or exchange number. */
  entityNumber: z.string().optional(),
  /** In history: the order's status (the web hides Refund on fulfilled orders). */
  orderStatus: z.string().nullable().optional(),
});
export type Payment = z.infer<typeof PaymentSchema>;

/** A calendar date, YYYY-MM-DD. */
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD');

export const PaymentListQuerySchema = ListPagingQuerySchema.extend({
  orderId: IdSchema.optional(),
  status: PaymentStatusSchema.optional(),
  paymentMethod: z.string().optional(),
  /** From this day on. */
  dateFrom: DateOnlySchema.optional(),
  /** Up to and including this day. */
  dateTo: DateOnlySchema.optional(),
});
export type PaymentListQuery = z.infer<typeof PaymentListQuerySchema>;

export const PaymentListResponseSchema = z.object({
  items: z.array(PaymentSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type PaymentListResponse = z.infer<typeof PaymentListResponseSchema>;

export const OrderPaymentListResponseSchema = z.object({ items: z.array(PaymentSchema) });
export type OrderPaymentListResponse = z.infer<typeof OrderPaymentListResponseSchema>;

export const PaymentRefundListResponseSchema = z.object({ items: z.array(PaymentRefundSchema) });
export type PaymentRefundListResponse = z.infer<typeof PaymentRefundListResponseSchema>;

export const CreatePaymentRequestSchema = z.object({
  orderId: IdSchema,
  amount: MoneyInputSchema,
  paymentMethod: OrderPaymentMethodSchema,
  transactionReference: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  /** Required for bank: an active account of the session branch. */
  bankAccountId: IdSchema.nullable().optional(),
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;

export const RefundPaymentRequestSchema = z.object({
  refundAmount: MoneyInputSchema,
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
  /** Bank payments only: the account the money leaves; the payment's account when omitted. */
  bankAccountId: IdSchema.nullable().optional(),
});
export type RefundPaymentRequest = z.infer<typeof RefundPaymentRequestSchema>;

export const UnpaidSourceTypeSchema = z.enum(['order', 'pos', 'exchange_difference']);

export const UnpaidListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  /** With sourceType: one order id, POS sale id or receivable id. */
  entityId: z.string().optional(),
  sourceType: UnpaidSourceTypeSchema.optional(),
});
export type UnpaidListQuery = z.infer<typeof UnpaidListQuerySchema>;

export const UnpaidItemSchema = z.object({
  /** Order id, POS sale id, or (exchange difference) receivable id: unique only with sourceType. */
  id: z.string(),
  orderNumber: z.string(),
  customerName: z.string().nullable(),
  customerCode: z.string().nullable(),
  total: z.number(),
  /** Paid less refunded. */
  totalPaid: z.number(),
  outstanding: z.number(),
  paymentStatus: z.string(),
  status: z.string(),
  channel: z.string(),
  createdAt: z.string(),
  sourceType: UnpaidSourceTypeSchema,
});
export type UnpaidItem = z.infer<typeof UnpaidItemSchema>;

export const UnpaidListResponseSchema = z.object({
  items: z.array(UnpaidItemSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type UnpaidListResponse = z.infer<typeof UnpaidListResponseSchema>;

export const OrderBalanceSchema = z.object({
  orderTotal: z.number(),
  /** Every payment received, refunded or not. */
  totalPaid: z.number(),
  totalRefunded: z.number(),
  /** What the customer still owes: total less paid plus refunded, never below zero. */
  outstanding: z.number(),
  paymentStatus: z.string(),
});
export type OrderBalance = z.infer<typeof OrderBalanceSchema>;
