import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema } from './common.js';

/** Contracts for /api/v1/inventory (#21). Stock is held per book and location. */

export const StockLevelSchema = z.object({
  bookId: z.number().int(),
  bookTitle: z.string(),
  bookIsbn: z.string(),
  bookIsActive: z.boolean(),
  locationId: z.number().int(),
  locationName: z.string(),
  branchId: z.number().int(),
  quantity: z.number().int(),
  /** Units of confirmed, unfulfilled orders. Already deducted from `quantity`; for information only. */
  reserved: z.number().int(),
  available: z.number().int(),
  reorderPoint: z.number().int(),
  /** Send it back with the next change to this row; a stale value gets 409 VERSION_CONFLICT. */
  version: z.number().int(),
  isLowStock: z.boolean(),
  updatedAt: z.string(),
});
export type StockLevel = z.infer<typeof StockLevelSchema>;

const BooleanQuerySchema = z.enum(['true', 'false']).transform((v) => v === 'true');

export const StockLevelListQuerySchema = ListPagingQuerySchema.extend({
  /** Another branch; only for staff with access to all branches. */
  branchId: IdSchema.optional(),
  locationId: IdSchema.optional(),
  bookId: IdSchema.optional(),
  lowStockOnly: BooleanQuerySchema.optional(),
  /** Title or ISBN. */
  q: z.string().optional(),
  /** Books' active flag; active books only when omitted. */
  is_active: z.enum(['true', 'false', 'all']).optional(),
  /** Books' lifecycle; when present it replaces `is_active`. */
  status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
  sortBy: z.enum(['title', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});
export type StockLevelListQuery = z.infer<typeof StockLevelListQuerySchema>;

export const StockLevelListResponseSchema = z.object({
  items: z.array(StockLevelSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type StockLevelListResponse = z.infer<typeof StockLevelListResponseSchema>;

export const BranchPagingQuerySchema = ListPagingQuerySchema.extend({
  /** Another branch; only for staff with access to all branches. */
  branchId: IdSchema.optional(),
});

export const MovementTypeSchema = z.enum(['stock_in', 'stock_out', 'transfer_in', 'transfer_out', 'adjustment']);
export type MovementType = z.infer<typeof MovementTypeSchema>;

export const StockMovementSchema = z.object({
  id: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  locationId: z.number().int(),
  locationName: z.string(),
  qtyBefore: z.number().int(),
  qtyAfter: z.number().int(),
  delta: z.number().int(),
  movementType: MovementTypeSchema,
  reasonCode: z.string(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  notes: z.string().nullable(),
  staffId: z.number().int(),
  staffUsername: z.string(),
  createdAt: z.string(),
});
export type StockMovement = z.infer<typeof StockMovementSchema>;

const DateQuerySchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a date, e.g. 2026-10-09');

export const StockMovementListQuerySchema = BranchPagingQuerySchema.extend({
  bookId: IdSchema.optional(),
  locationId: IdSchema.optional(),
  reasonCode: z.string().max(50).optional(),
  movementType: MovementTypeSchema.optional(),
  /** ISO date or timestamp, inclusive. */
  dateFrom: DateQuerySchema.optional(),
  dateTo: DateQuerySchema.optional(),
});
export type StockMovementListQuery = z.infer<typeof StockMovementListQuerySchema>;

export const StockMovementListResponseSchema = z.object({
  items: z.array(StockMovementSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type StockMovementListResponse = z.infer<typeof StockMovementListResponseSchema>;

/** What a stock movement may point at (the database accepts only these). */
export const StockReferenceTypeSchema = z.enum([
  'purchase_order',
  'return',
  'adjustment',
  'manual',
  'initial_stock',
  'sale',
  'void',
  'pos_return',
  'order',
  'exchange_in',
  'exchange_out',
  'exchange_damaged',
  'order_confirmed',
  'order_cancelled',
  'order_fulfilled',
  'order_return',
  'transfer',
  'customer_exchange',
]);

/**
 * Why stock was adjusted by hand. Damage and loss take stock away, a return
 * puts it back, and a correction (a count discrepancy) goes either way.
 */
export const AdjustmentReasonSchema = z.enum(['damage', 'loss', 'return', 'correction']);
export type AdjustmentReason = z.infer<typeof AdjustmentReasonSchema>;

export const AdjustStockRequestSchema = z.object({
  bookId: IdSchema,
  locationId: IdSchema,
  delta: z.number().int().refine((n) => n !== 0, 'Delta cannot be zero'),
  reasonCode: AdjustmentReasonSchema,
  notes: z.string().max(500).optional(),
  version: z.number().int().min(0),
  referenceType: StockReferenceTypeSchema.optional(),
  referenceId: IdSchema.optional(),
});
export type AdjustStockRequest = z.infer<typeof AdjustStockRequestSchema>;

export const TransferStockRequestSchema = z.object({
  bookId: IdSchema,
  fromLocationId: IdSchema,
  toLocationId: IdSchema,
  quantity: z.number().int().positive(),
  fromVersion: z.number().int().min(0),
});
export type TransferStockRequest = z.infer<typeof TransferStockRequestSchema>;

export const TransferStockResponseSchema = z.object({ from: StockLevelSchema, to: StockLevelSchema });
export type TransferStockResponse = z.infer<typeof TransferStockResponseSchema>;

export const StockInRequestSchema = z
  .object({
    bookId: IdSchema,
    locationId: IdSchema,
    quantity: z.number().int().positive(),
    version: z.number().int().min(0),
    referenceType: z.enum(['purchase_order', 'return', 'adjustment', 'manual', 'initial_stock']).optional(),
    referenceId: IdSchema.optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((r) => r.referenceType !== 'purchase_order' || r.referenceId !== undefined, {
    message: 'referenceId is required when referenceType is purchase_order',
    path: ['referenceId'],
  });
export type StockInRequest = z.infer<typeof StockInRequestSchema>;

export const StockOutRequestSchema = z.object({
  bookId: IdSchema,
  locationId: IdSchema,
  quantity: z.number().int().positive(),
  version: z.number().int().min(0),
  referenceType: StockReferenceTypeSchema.optional(),
  referenceId: IdSchema.optional(),
  notes: z.string().max(500).optional(),
});
export type StockOutRequest = z.infer<typeof StockOutRequestSchema>;

export const ReorderPointRequestSchema = z.object({
  bookId: IdSchema,
  locationId: IdSchema,
  reorderPoint: z.number().int().min(0),
});
export type ReorderPointRequest = z.infer<typeof ReorderPointRequestSchema>;

export const BookStockParamsSchema = z.object({ bookId: IdSchema });

export const BookStockQuerySchema = z.object({
  /** Any branch: staff may see where a book is in stock (#12). The session's branch when omitted. */
  branchId: IdSchema.optional(),
});

export const LocationStockSchema = z.object({
  locationId: z.number().int(),
  locationName: z.string(),
  branchId: z.number().int(),
  quantity: z.number().int(),
  reserved: z.number().int(),
  damaged: z.number().int(),
  available: z.number().int(),
  /** Available units that are not damaged. */
  sellable: z.number().int(),
});
export type LocationStock = z.infer<typeof LocationStockSchema>;

export const BookStockResponseSchema = z.object({ items: z.array(LocationStockSchema) });
export type BookStockResponse = z.infer<typeof BookStockResponseSchema>;
