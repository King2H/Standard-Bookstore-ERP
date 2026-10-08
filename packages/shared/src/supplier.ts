import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, IdSchema, LifecycleStatusSchema, MAX_PAGE_SIZE, PaginatedSchema } from './common.js';

/** Contracts for /api/v1/suppliers and /api/v1/books/{bookId}/suppliers (#19). */

export const SupplierTypeSchema = z.enum(['external', 'publisher']);
export type SupplierType = z.infer<typeof SupplierTypeSchema>;

export const SupplierSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  contactInfo: z.record(z.string(), z.unknown()),
  leadTimeDays: z.number().int(),
  pricingTerms: z.string().nullable(),
  supplierType: SupplierTypeSchema,
  publisherId: z.number().int().nullable(),
  publisherName: z.string().nullable(),
  isActive: z.boolean(),
  /** A misconduct ban, separate from the lifecycle status. */
  isBlacklisted: z.boolean(),
  status: LifecycleStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

const BooleanQuerySchema = z.enum(['true', 'false']).transform((v) => v === 'true');

export const SupplierListQuerySchema = z.object({
  supplierType: SupplierTypeSchema.optional(),
  isActive: BooleanQuerySchema.optional(),
  isBlacklisted: BooleanQuerySchema.optional(),
  /** Lifecycle filter. When present it replaces `isActive`. */
  status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
  /** Case-insensitive match on the name. */
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Larger values are capped instead of rejected: the procurement supplier
  // picker asks for 200 to get "all of them" in one request.
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_PAGE_SIZE)
    .transform((n) => Math.min(n, MAX_PAGE_SIZE)),
});
export type SupplierListQuery = z.infer<typeof SupplierListQuerySchema>;

export const SupplierListResponseSchema = PaginatedSchema(SupplierSchema);
export type SupplierListResponse = z.infer<typeof SupplierListResponseSchema>;

export const CreateSupplierRequestSchema = z.object({
  name: z.string().min(1),
  contactInfo: z.record(z.string(), z.unknown()),
  leadTimeDays: z.number().int().min(0).optional(),
  pricingTerms: z.string().nullable().optional(),
  supplierType: SupplierTypeSchema,
  /** Required for publisher suppliers, not allowed for external ones. */
  publisherId: IdSchema.nullable().optional(),
});
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = z.object({
  name: z.string().min(1).optional(),
  contactInfo: z.record(z.string(), z.unknown()).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  pricingTerms: z.string().nullable().optional(),
  supplierType: SupplierTypeSchema.optional(),
  publisherId: IdSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequestSchema>;

/** Counts of records that reference the supplier and so block deleting it. */
export const SupplierUsageSchema = z.object({
  purchaseOrders: z.number().int().min(0),
});
export type SupplierUsage = z.infer<typeof SupplierUsageSchema>;

export const BookIdParamsSchema = z.object({ bookId: IdSchema });
export const BookSupplierParamsSchema = z.object({ bookId: IdSchema, supplierId: IdSchema });

export const BookSupplierSchema = z.object({
  bookId: z.number().int(),
  supplierId: z.number().int(),
  supplierName: z.string(),
  supplierSku: z.string().nullable(),
  isPrimary: z.boolean(),
});
export type BookSupplier = z.infer<typeof BookSupplierSchema>;

export const BookSupplierListResponseSchema = z.object({ items: z.array(BookSupplierSchema) });
export type BookSupplierListResponse = z.infer<typeof BookSupplierListResponseSchema>;

export const LinkBookSupplierRequestSchema = z.object({
  supplierId: IdSchema,
  supplierSku: z.string().nullable().optional(),
  /** Makes this the book's only primary supplier. */
  isPrimary: z.boolean().optional(),
});
export type LinkBookSupplierRequest = z.infer<typeof LinkBookSupplierRequestSchema>;
