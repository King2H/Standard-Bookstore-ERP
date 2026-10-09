import { z } from 'zod';
import { IdSchema, MAX_PAGE_SIZE } from './common.js';

/** Contracts for /api/v1/financial-transactions (#21). */

export const FinancialTransactionTypeSchema = z.enum(['payment', 'refund', 'adjustment']);
export type FinancialTransactionType = z.infer<typeof FinancialTransactionTypeSchema>;

/** A ledger entry, written by the flow that also updates its order or exchange. */
export const FinancialTransactionSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  type: FinancialTransactionTypeSchema,
  orderId: z.string().nullable(),
  exchangeId: z.string().nullable(),
  idempotencyKey: z.string(),
  amount: z.number(),
  currency: z.string(),
  method: z.string().nullable(),
  staffId: z.number().int(),
  branchId: z.number().int(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type FinancialTransaction = z.infer<typeof FinancialTransactionSchema>;

export const FinancialTransactionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(25)
    .transform((n) => Math.min(n, MAX_PAGE_SIZE)),
  orderId: IdSchema.optional(),
  exchangeId: IdSchema.optional(),
  type: FinancialTransactionTypeSchema.optional(),
  /** Another branch than the session's needs access to all branches. */
  branchId: IdSchema.optional(),
});
export type FinancialTransactionListQuery = z.infer<typeof FinancialTransactionListQuerySchema>;

export const FinancialTransactionListResponseSchema = z.object({
  items: z.array(FinancialTransactionSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type FinancialTransactionListResponse = z.infer<typeof FinancialTransactionListResponseSchema>;
