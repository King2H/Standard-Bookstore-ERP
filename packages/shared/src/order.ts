import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, PaginatedSchema } from './common.js';

/** Contracts for /api/v1/orders (#20). */

export const SaleTypeSchema = z.enum(['cash_sale', 'credit_sale']);
export const OrderChannelSchema = z.enum(['in_store', 'phone', 'online']);
export const DiscountTypeSchema = z.enum(['Normal', 'Merchant', 'Special']);
export const DiscountModeSchema = z.enum(['Percentage', 'Amount']);

const DateQuerySchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a date, e.g. 2026-10-08');

export const OrderLineItemSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  bookIsbn: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number(),
  discountAmount: z.number(),
  totalPrice: z.number(),
  qtyReserved: z.number().int(),
  qtyFulfilled: z.number().int(),
  isBackordered: z.boolean(),
  /** Cost the line left stock at (set at confirmation). */
  unitCost: z.number().nullable(),
});
export type OrderLineItem = z.infer<typeof OrderLineItemSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  customerId: z.number().int().nullable(),
  branchId: z.number().int(),
  locationId: z.number().int().nullable(),
  channel: z.string(),
  /** DRAFT, CONFIRMED, PAID, FULFILLED, COMPLETED or CANCELLED; older rows may hold pre-v1.1 names. */
  status: z.string(),
  paymentStatus: z.string(),
  saleType: SaleTypeSchema,
  currency: z.string(),
  subtotal: z.number(),
  discountAmount: z.number(),
  discountTotal: z.number(),
  taxRate: z.number(),
  taxAmount: z.number(),
  total: z.number(),
  cancelReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Present on single-order responses, absent in lists. */
  lineItems: z.array(OrderLineItemSchema).optional(),
  /** What the signed-in staff member may do next, e.g. ["confirm", "cancel"]. */
  allowedActions: z.array(z.string()),
  paymentMethod: z.string().nullable(),
  /** Due date of a credit sale's receivable (YYYY-MM-DD). */
  dueDate: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  /** One status, or several separated by commas: "CONFIRMED,PAID". */
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
  channel: OrderChannelSchema.optional(),
  dateFrom: DateQuerySchema.optional(),
  dateTo: DateQuerySchema.optional(),
});
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;

export const OrderListResponseSchema = PaginatedSchema(OrderSchema);
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;

export const OrderLineInputSchema = z.object({
  bookId: IdSchema,
  quantity: z.number().int().positive(),
  /** With discountMode "Amount" (or no discount fields at all): the line's discount. */
  discountAmount: z.number().nullable().optional(),
  /** With discountMode "Percentage": 0 to 100. */
  discountPct: z.number().nullable().optional(),
  discountType: DiscountTypeSchema.optional(),
  discountMode: DiscountModeSchema.optional(),
});

export const CreateOrderRequestSchema = z.object({
  /** Required for credit sales. */
  customerId: IdSchema.nullable().optional(),
  /** Defaults to the branch's fulfilment location. */
  locationId: IdSchema.nullable().optional(),
  channel: OrderChannelSchema.default('in_store'),
  notes: z.string().optional(),
  saleType: SaleTypeSchema.default('cash_sale'),
  items: z.array(OrderLineInputSchema).min(1),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const ConfirmOrderRequestSchema = z.object({
  /** Credit sales: the receivable's due date, YYYY-MM-DD, today or later. */
  dueDate: z.string().nullable().optional(),
  /** Cash sales: cash (default), bank, mobile or store_credit. */
  paymentMethod: z.string().nullable().optional(),
});
export type ConfirmOrderRequest = z.infer<typeof ConfirmOrderRequestSchema>;

export const CancelOrderRequestSchema = z.object({
  reason: z.string().default('No reason provided'),
});
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;

export const CollectOrderPaymentRequestSchema = z.object({
  amount: z.number().positive(),
});
export type CollectOrderPaymentRequest = z.infer<typeof CollectOrderPaymentRequestSchema>;
