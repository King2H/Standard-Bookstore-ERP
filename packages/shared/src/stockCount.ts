import { z } from 'zod';
import { IdSchema, PaginatedSchema, PaginationQuerySchema } from './common.js';

/**
 * Contracts for /api/v1/stock-counts (#172, owner decisions 1a–6a,
 * 2026-10-30): a stocktake of one location, the whole of it or chosen books,
 * numbered CNT-. Expected quantities are frozen when it opens and selling
 * goes on: each count is set against the stock at the moment it was entered,
 * so a sale during the count is never a shortage. Counting is blind; an
 * Admin or Manager reviews the differences, asks for recounts, and posts one
 * adjustment per difference at the average cost.
 */

export const StockCountStatusSchema = z.enum(['counting', 'submitted', 'posted', 'cancelled']);
export type StockCountStatus = z.infer<typeof StockCountStatusSchema>;

export const StockCountScopeSchema = z.enum(['full', 'selected']);
export type StockCountScope = z.infer<typeof StockCountScopeSchema>;

export const StockCountLineSchema = z.object({
  id: z.number().int(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  isbn: z.string().nullable(),
  /**
   * On hand when the count opened, and on hand when the book was counted
   * (the first plus what moved since). Hidden (null) from counters while
   * counting, so the count is blind.
   */
  frozenQuantity: z.number().int().nullable(),
  expectedQuantity: z.number().int().nullable(),
  countedQuantity: z.number().int().nullable(),
  /** Counted less expected; null until counted, and while hidden. */
  difference: z.number().int().nullable(),
  /** The difference at the average cost; null until counted, and while hidden. */
  differenceValue: z.number().nullable(),
  countedBy: z.number().int().nullable(),
  countedByName: z.string().nullable(),
  countedAt: z.string().nullable(),
  /** Earlier counts of the book on this count, newest last. */
  previousCounts: z.array(z.number().int()),
  recountRequested: z.boolean(),
  /** What posting changed: the difference applied, at this cost. */
  postedDelta: z.number().int().nullable(),
  postedUnitCost: z.number().nullable(),
});
export type StockCountLine = z.infer<typeof StockCountLineSchema>;

export const StockCountSchema = z.object({
  id: z.number().int(),
  /** CNT-YYYYMMDD-NNNN. */
  countNumber: z.string(),
  branchId: z.number().int(),
  locationId: z.number().int(),
  locationName: z.string(),
  scope: StockCountScopeSchema,
  status: StockCountStatusSchema,
  notes: z.string().nullable(),
  createdBy: z.number().int(),
  createdByName: z.string(),
  createdAt: z.string(),
  submittedAt: z.string().nullable(),
  postedBy: z.number().int().nullable(),
  postedByName: z.string().nullable(),
  postedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  lineCount: z.number().int(),
  countedLines: z.number().int(),
});
export type StockCount = z.infer<typeof StockCountSchema>;

/** A count with its lines and, where the viewer may see them, the totals of the differences. */
export const StockCountDetailSchema = StockCountSchema.extend({
  lines: z.array(StockCountLineSchema),
  /** Copies over and short, and their value at the average cost; null while hidden. */
  totals: z
    .object({ overQuantity: z.number().int(), shortQuantity: z.number().int(), overValue: z.number(), shortValue: z.number() })
    .nullable(),
});
export type StockCountDetail = z.infer<typeof StockCountDetailSchema>;

export const StockCountListQuerySchema = PaginationQuerySchema.extend({
  status: StockCountStatusSchema.optional(),
  locationId: IdSchema.optional(),
});
export type StockCountListQuery = z.infer<typeof StockCountListQuerySchema>;

export const StockCountListResponseSchema = PaginatedSchema(StockCountSchema);
export type StockCountListResponse = z.infer<typeof StockCountListResponseSchema>;

const ReasonSchema = z.string().trim().min(1, 'A reason is required').max(500);
const BookIdsSchema = z
  .array(IdSchema)
  .min(1, 'At least one book is required')
  .max(2000)
  .refine((ids) => new Set(ids).size === ids.length, 'Each book once');

/** A count of a location: every book it holds (full), or the books named (selected). */
export const OpenStockCountRequestSchema = z
  .object({
    locationId: IdSchema,
    scope: StockCountScopeSchema,
    bookIds: BookIdsSchema.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((c) => (c.scope === 'selected') === (c.bookIds !== undefined), {
    message: 'A selected count names its books; a full count takes every book of the location',
    path: ['bookIds'],
  });
export type OpenStockCountRequest = z.infer<typeof OpenStockCountRequestSchema>;

/** Counted quantities; a book found that is not on the count is added. A book counted again replaces its count. */
export const EnterStockCountsRequestSchema = z.object({
  items: z
    .array(z.object({ bookId: IdSchema, quantity: z.number().int().min(0) }))
    .min(1, 'At least one count is required')
    .max(500)
    .refine((items) => new Set(items.map((i) => i.bookId)).size === items.length, 'Each book once per entry'),
});
export type EnterStockCountsRequest = z.infer<typeof EnterStockCountsRequestSchema>;

/** A reviewer sends books back to be counted again. */
export const RecountRequestSchema = z.object({ bookIds: BookIdsSchema });
export type RecountRequest = z.infer<typeof RecountRequestSchema>;

/** Posting; books never counted are left unchanged, unless named here to be counted as 0. */
export const PostStockCountRequestSchema = z.object({ zeroBookIds: z.array(IdSchema).max(2000).default([]) });
export type PostStockCountRequest = z.infer<typeof PostStockCountRequestSchema>;

export const CancelStockCountRequestSchema = z.object({ reason: ReasonSchema });
export type CancelStockCountRequest = z.infer<typeof CancelStockCountRequestSchema>;
