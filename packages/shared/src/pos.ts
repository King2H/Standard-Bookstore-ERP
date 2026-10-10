import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, MoneyInputSchema } from './common.js';

/** Contracts for /api/v1/pos: counter sales (#21). */

export const PosPaymentMethodSchema = z.enum(['cash', 'bank', 'mobile', 'store_credit', 'loyalty_points']);
export type PosPaymentMethod = z.infer<typeof PosPaymentMethodSchema>;

export const PosPaymentStatusSchema = z.enum(['paid', 'partial', 'credit']);
export type PosPaymentStatus = z.infer<typeof PosPaymentStatusSchema>;

export const PosLineItemSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  bookIsbn: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number(),
  discountPct: z.number(),
  discountAmount: z.number(),
  lineTotal: z.number(),
  /** Average cost when sold; null for sales before costs were kept. */
  unitCost: z.number().nullable(),
});

export const PosPaymentSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  method: z.string(),
  amount: z.number(),
  reference: z.string().nullable(),
  createdAt: z.string(),
});

export const PosTransactionSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  branchId: z.number().int(),
  locationId: z.number().int(),
  customerId: z.number().int().nullable(),
  staffId: z.number().int(),
  /** POS-YYYYMMDD-NNNN. */
  transactionNumber: z.string(),
  subtotal: z.number(),
  discountTotal: z.number(),
  taxTotal: z.number(),
  grandTotal: z.number(),
  amountPaid: z.number(),
  amountDue: z.number(),
  paymentStatus: PosPaymentStatusSchema,
  currency: z.string(),
  status: z.enum(['completed', 'voided']),
  createdAt: z.string(),
  /** The credit sale's due date, YYYY-MM-DD. */
  dueDate: z.string().nullable(),
  /** Whether it can still be voided: completed, sold today, nothing returned. */
  voidable: z.boolean(),
  /** On a single sale only. */
  lineItems: z.array(PosLineItemSchema).optional(),
  payments: z.array(PosPaymentSchema).optional(),
});
export type PosTransaction = z.infer<typeof PosTransactionSchema>;

/** A calendar date, YYYY-MM-DD, that exists. */
const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a calendar date');

export const PosTransactionListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  staffId: IdSchema.optional(),
  /** From this day on. */
  dateFrom: DateOnlySchema.optional(),
  /** Up to and including this day. */
  dateTo: DateOnlySchema.optional(),
  status: z.enum(['completed', 'voided']).optional(),
  paymentStatus: PosPaymentStatusSchema.optional(),
  transactionNumber: z.string().optional(),
});
export type PosTransactionListQuery = z.infer<typeof PosTransactionListQuerySchema>;

export const PosTransactionListResponseSchema = z.object({
  items: z.array(PosTransactionSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type PosTransactionListResponse = z.infer<typeof PosTransactionListResponseSchema>;

export const PosPaymentInputSchema = z.object({
  method: PosPaymentMethodSchema,
  amount: MoneyInputSchema.refine((v) => Number(v) > 0, 'Must be more than zero'),
  reference: z.string().max(200).optional(),
});
export type PosPaymentInput = z.infer<typeof PosPaymentInputSchema>;

export const PosLineInputSchema = z.object({
  bookId: IdSchema,
  quantity: z.number().int().positive(),
  /** Clamped to 0–100. */
  discountPct: z.number().transform((n) => Math.min(100, Math.max(0, n))).optional(),
  /** With discountMode Amount: the line's discount in money, at most the line's value. */
  discountAmount: z.number().transform((n) => Math.max(0, n)).optional(),
  discountMode: z.enum(['Percentage', 'Amount']).optional(),
  /** Informational: which discount preset the cashier used. */
  discountType: z.enum(['Normal', 'Merchant', 'Special']).optional(),
});
export type PosLineInput = z.infer<typeof PosLineInputSchema>;

export const CreatePosTransactionRequestSchema = z.object({
  /** The session branch; another is refused. */
  branchId: IdSchema.optional(),
  locationId: IdSchema,
  customerId: IdSchema.nullable().optional(),
  items: z.array(PosLineInputSchema).min(1, 'At least one item is required'),
  payments: z.array(PosPaymentInputSchema).default([]),
  /** A credit sale: payments may be less than the total; needs a customer. */
  allowCredit: z.boolean().default(false),
  /** Credit sales: when the rest is due, today or later. */
  dueDate: DateOnlySchema.nullable().optional(),
});
export type CreatePosTransactionRequest = z.infer<typeof CreatePosTransactionRequestSchema>;

export const PosCollectRequestSchema = z.object({
  payments: z.array(PosPaymentInputSchema).min(1, 'At least one payment is required'),
});
export type PosCollectRequest = z.infer<typeof PosCollectRequestSchema>;
