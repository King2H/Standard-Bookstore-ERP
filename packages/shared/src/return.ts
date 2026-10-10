import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema } from './common.js';

/** Contracts for /api/v1/returns: books brought back from a counter sale (#21). */

/**
 * How a return's value went back: the payment methods of the sale (owner
 * decision 2a), or credit_note when it was set against what the customer
 * still owed on a credit sale. A return refunded more than one way says mixed.
 */
export const RefundMethodSchema = z.enum(['cash', 'bank', 'mobile', 'store_credit', 'loyalty_points', 'credit_note']);
export type RefundMethod = z.infer<typeof RefundMethodSchema>;

export const ReturnLineSchema = z.object({
  id: z.string(),
  returnId: z.string(),
  transactionLineItemId: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number(),
  lineRefundAmount: z.number(),
});

export const ReturnRefundSchema = z.object({
  id: z.string(),
  returnId: z.string(),
  method: RefundMethodSchema,
  amount: z.number(),
  createdAt: z.string(),
});

export const ReturnSchema = z.object({
  id: z.string(),
  /** RET-YYYYMMDD-NNNN. */
  returnNumber: z.string(),
  transactionId: z.string(),
  branchId: z.number().int(),
  customerId: z.number().int().nullable(),
  /** What the returned books were worth: credited and refunded together. */
  totalRefundAmount: z.number(),
  refundMethod: z.union([RefundMethodSchema, z.literal('mixed')]),
  status: z.enum(['completed', 'rejected']),
  reason: z.string().nullable(),
  processedBy: z.number().int(),
  /** The Manager or Admin who processed a return above the approval limit. */
  approvedBy: z.number().int().nullable(),
  createdAt: z.string(),
  /** On a single return only. */
  lineItems: z.array(ReturnLineSchema).optional(),
  refunds: z.array(ReturnRefundSchema).optional(),
});
export type Return = z.infer<typeof ReturnSchema>;

/** A calendar date, YYYY-MM-DD. */
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD');

export const ReturnListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  transactionId: IdSchema.optional(),
  status: z.enum(['completed', 'rejected']).optional(),
  /** From this day on. */
  dateFrom: DateOnlySchema.optional(),
  /** Up to and including this day. */
  dateTo: DateOnlySchema.optional(),
});
export type ReturnListQuery = z.infer<typeof ReturnListQuerySchema>;

export const ReturnListResponseSchema = z.object({
  items: z.array(ReturnSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type ReturnListResponse = z.infer<typeof ReturnListResponseSchema>;

export const ReturnLineInputSchema = z.object({
  transactionLineItemId: IdSchema,
  quantity: z.number().int().positive(),
  /** SELLABLE (default) goes back on the shelf; DAMAGED is kept apart, not for sale. */
  disposition: z.enum(['SELLABLE', 'DAMAGED']).default('SELLABLE'),
});
export type ReturnLineInput = z.infer<typeof ReturnLineInputSchema>;

/**
 * The refund goes back the way the sale was paid, so the request names no
 * method; returns above the approval limit are for a Manager or Admin.
 */
export const CreateReturnRequestSchema = z.object({
  transactionId: IdSchema,
  reason: z.string().max(1000).optional(),
  lines: z.array(ReturnLineInputSchema).min(1, 'At least one line item is required'),
});
export type CreateReturnRequest = z.infer<typeof CreateReturnRequestSchema>;
