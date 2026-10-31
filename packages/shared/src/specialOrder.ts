import { z } from 'zod';
import { IdSchema, MoneyInputSchema, PaginatedSchema, PaginationQuerySchema } from './common.js';

/**
 * Contracts for special orders (#174, owner decisions 4a and 1a–6a,
 * 2026-10-31): order lines for books not in stock, confirmed without it and
 * bought for the customer on a purchase order.
 */

/** A special-order line with copies still on order: what purchasers buy. */
export const SpecialOrderLineSchema = z.object({
  /** The order's line, a bigint sent as a string like the order's line ids. */
  orderLineId: z.string(),
  orderId: z.string(),
  /** ORD-YYYYMMDD-NNNN. */
  orderNumber: z.string(),
  orderedAt: z.string(),
  customerId: z.number().int().nullable(),
  customerName: z.string().nullable(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  isbn: z.string().nullable(),
  /** Copies ordered on the line. */
  quantity: z.number().int(),
  /** Copies neither arrived, delivered nor cancelled. */
  onOrder: z.number().int(),
  /** Of those, on a purchase order still to arrive. */
  linked: z.number().int(),
  /** Of those, on no purchase order yet: what is left to buy. */
  toOrder: z.number().int(),
  /** The purchase orders bringing them. */
  purchaseOrders: z.array(z.object({ poId: z.string(), poNumber: z.string(), quantity: z.number().int(), reserved: z.number().int() })),
});
export type SpecialOrderLine = z.infer<typeof SpecialOrderLineSchema>;

export const SpecialOrderListQuerySchema = PaginationQuerySchema.extend({
  /** Only lines with copies on no purchase order yet. */
  toOrder: z.enum(['true', 'false']).optional(),
});
export type SpecialOrderListQuery = z.infer<typeof SpecialOrderListQuerySchema>;

export const SpecialOrderListResponseSchema = PaginatedSchema(SpecialOrderLineSchema);
export type SpecialOrderListResponse = z.infer<typeof SpecialOrderListResponseSchema>;

/**
 * Special-order lines added to a purchase order (decision 3a): its line for
 * the book grows by their copies, or is created at `unitCost`.
 */
export const SpecialOrderLinkLinesSchema = z
  .array(z.object({
    orderLineId: IdSchema,
    quantity: z.number().int().positive(),
    /** Needed only when the purchase order has no line for the book yet. */
    unitCost: MoneyInputSchema.refine((v) => Number(v) >= 0, 'Cannot be negative').optional(),
  }))
  .max(200)
  .refine((lines) => new Set(lines.map((l) => l.orderLineId)).size === lines.length, 'Each line once');

export const LinkSpecialOrdersRequestSchema = z.object({
  lines: SpecialOrderLinkLinesSchema.refine((lines) => lines.length > 0, 'At least one line is required'),
});
export type LinkSpecialOrdersRequest = z.infer<typeof LinkSpecialOrdersRequestSchema>;
