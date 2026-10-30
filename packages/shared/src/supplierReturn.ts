import { z } from 'zod';
import { IdSchema, PaginatedSchema, PaginationQuerySchema } from './common.js';

/**
 * Contracts for /api/v1/supplier-returns (#173, owner decisions 1a–6a,
 * 2026-10-30): books going back to a supplier against a purchase order,
 * numbered RTS-. A draft names lines of the order, up to what arrived less
 * what already went back, each from a location of the receiving branch, from
 * stock for sale or from damaged copies. Sending takes the copies out at
 * their cost and creates a credit note at the order's price; the difference
 * is a gain or a loss on the return.
 */

export const SupplierReturnStatusSchema = z.enum(['draft', 'sent', 'cancelled']);
export type SupplierReturnStatus = z.infer<typeof SupplierReturnStatusSchema>;

/** stock: copies for sale; damaged: copies kept apart as damaged (#168). */
export const SupplierReturnSourceSchema = z.enum(['stock', 'damaged']);
export type SupplierReturnSource = z.infer<typeof SupplierReturnSourceSchema>;

export const SupplierReturnLineSchema = z.object({
  id: z.number().int(),
  /** A bigint, sent as a string, like the order's line ids. */
  poLineItemId: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  isbn: z.string().nullable(),
  locationId: z.number().int(),
  locationName: z.string(),
  source: SupplierReturnSourceSchema,
  quantity: z.number().int(),
  /** The order's price for one copy: what the supplier credits. */
  unitCredit: z.number(),
  creditValue: z.number(),
  /** What one copy cost when it left; null until sent. */
  unitCost: z.number().nullable(),
  costValue: z.number().nullable(),
});
export type SupplierReturnLine = z.infer<typeof SupplierReturnLineSchema>;

export const SupplierReturnSchema = z.object({
  id: z.number().int(),
  /** RTS-YYYYMMDD-NNNN. */
  returnNumber: z.string(),
  poId: z.string(),
  /** PO-000123. */
  poNumber: z.string(),
  /** The receiving branch: the copies leave from there. */
  branchId: z.number().int(),
  supplierId: z.number().int(),
  supplierName: z.string(),
  status: SupplierReturnStatusSchema,
  notes: z.string().nullable(),
  createdBy: z.number().int(),
  createdByName: z.string(),
  createdAt: z.string(),
  sentBy: z.number().int().nullable(),
  sentByName: z.string().nullable(),
  sentAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  lineCount: z.number().int(),
  totalQuantity: z.number().int(),
  /** At the order's price. */
  creditValue: z.number(),
  /** What the copies cost when they left; null until sent. */
  costValue: z.number().nullable(),
  /** Credit less cost: above zero a gain, below a loss; null until sent. */
  gainLoss: z.number().nullable(),
  /** SCN-YYYYMMDD-NNNN, created when the return is sent. */
  creditNoteNumber: z.string().nullable(),
});
export type SupplierReturn = z.infer<typeof SupplierReturnSchema>;

export const SupplierReturnDetailSchema = SupplierReturnSchema.extend({ lines: z.array(SupplierReturnLineSchema) });
export type SupplierReturnDetail = z.infer<typeof SupplierReturnDetailSchema>;

export const SupplierReturnListQuerySchema = PaginationQuerySchema.extend({
  status: SupplierReturnStatusSchema.optional(),
  poId: IdSchema.optional(),
});
export type SupplierReturnListQuery = z.infer<typeof SupplierReturnListQuerySchema>;

export const SupplierReturnListResponseSchema = PaginatedSchema(SupplierReturnSchema);
export type SupplierReturnListResponse = z.infer<typeof SupplierReturnListResponseSchema>;

const ReturnLinesSchema = z
  .array(z.object({ poLineItemId: IdSchema, locationId: IdSchema, source: SupplierReturnSourceSchema, quantity: z.number().int().positive() }))
  .min(1, 'At least one line is required')
  .max(500)
  .refine(
    (lines) => new Set(lines.map((l) => `${l.poLineItemId}:${l.locationId}:${l.source}`)).size === lines.length,
    'Each line, location and source once',
  );

export const CreateSupplierReturnRequestSchema = z.object({
  poId: IdSchema,
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: ReturnLinesSchema,
});
export type CreateSupplierReturnRequest = z.infer<typeof CreateSupplierReturnRequestSchema>;

/** A draft's lines replaced; its notes too when given. */
export const UpdateSupplierReturnRequestSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: ReturnLinesSchema,
});
export type UpdateSupplierReturnRequest = z.infer<typeof UpdateSupplierReturnRequestSchema>;

export const CancelSupplierReturnRequestSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) });
export type CancelSupplierReturnRequest = z.infer<typeof CancelSupplierReturnRequestSchema>;
