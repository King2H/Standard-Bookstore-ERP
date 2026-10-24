import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, PaginatedSchema } from './common.js';
import { checkPaymentProof, PayerBankSchema, PaymentReferenceSchema } from './paymentProof.js';

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
  /** Copies of the line brought back through Returns (#166). */
  qtyReturned: z.number().int(),
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
  /** Payments taken less refunds: what cancelling gives back (#167). */
  amountPaid: z.number(),
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
  /** When the order was delivered; the return window counts from it (#166). */
  fulfilledAt: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  /** The order with this ORD- number. */
  orderNumber: z.string().trim().min(1).max(64).optional(),
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

export const ConfirmOrderRequestSchema = z
  .object({
    /** Credit sales: the receivable's due date, YYYY-MM-DD, today or later. */
    dueDate: z.string().nullable().optional(),
    /** Cash sales: cash (default), bank, mobile or store_credit. */
    paymentMethod: z.string().nullable().optional(),
    /** Cash sales paid by bank (the transfer's reference) or mobile (the Telebirr transaction number). */
    transactionReference: PaymentReferenceSchema.optional(),
    /** Cash sales paid by bank: the bank the customer paid from. */
    payerBank: PayerBankSchema.optional(),
    /** Cash sales paid by bank: an active account of the order's branch; required while bank accounts are on. */
    bankAccountId: IdSchema.nullable().optional(),
  })
  .superRefine(checkPaymentProof({ method: 'paymentMethod', reference: 'transactionReference' }));
export type ConfirmOrderRequest = z.infer<typeof ConfirmOrderRequestSchema>;

/** How the money an order took goes back when it is cancelled (#167): each payment the way it was paid, or store credit. */
export const CancelRefundToSchema = z.enum(['original', 'store_credit']);
export type CancelRefundTo = z.infer<typeof CancelRefundToSchema>;

/** Why the order is cancelled (owner decision 2a): a confirmed order's stock goes back, so the audit says why. */
export const CancelOrderRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
  /** Required when the order took payments (#167); store credit needs the order's customer. */
  refundTo: CancelRefundToSchema.optional(),
});
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;
