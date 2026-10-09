import { z } from 'zod';
import { IdSchema, LifecycleStatusSchema, ListPagingQuerySchema } from './common.js';

/** Contracts for books: /api/v1/books, /api/v1/catalog/* (#21). Books are shared by every branch. */

export const BookSchema = z.object({
  id: z.number().int(),
  /** ISBN-13 (an ISBN-10 is stored as its ISBN-13), or a SKU-based placeholder for a book without one. */
  isbn: z.string(),
  sku: z.string().nullable(),
  title: z.string(),
  authors: z.array(z.string()),
  authorIds: z.array(z.number().int()),
  genre: z.string().nullable(),
  publisher: z.string().nullable(),
  publisherId: z.number().int().nullable(),
  formatId: z.number().int().nullable(),
  formatCode: z.string().nullable(),
  formatLabel: z.string().nullable(),
  editionId: z.number().int().nullable(),
  editionCode: z.string().nullable(),
  editionLabel: z.string().nullable(),
  edition: z.string().nullable(),
  language: z.string().nullable(),
  format: z.string().nullable(),
  description: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  defaultPrice: z.number().nullable(),
  tradeValue: z.number().nullable(),
  /** True exactly when `status` is ACTIVE. */
  isActive: z.boolean(),
  status: LifecycleStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  categories: z.array(z.string()),
  categoryIds: z.array(z.number().int()),
  tags: z.array(z.string()),
  /** The price in the requested branch, when it has one of its own. */
  branchPrice: z.number().nullable().optional(),
  stockQuantity: z.number().int().nullable().optional(),
});
export type Book = z.infer<typeof BookSchema>;

// The sale screens send their branch and location even when they have none
// yet ("", "null", "0"); like the rest of the API, that means none given.
const OptionalIdQuerySchema = z.preprocess((v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}, z.number().int().positive().optional());

export const BookListQuerySchema = ListPagingQuerySchema.extend({
  /** Title, author, SKU, publisher or description, in part; or an exact ISBN-10 or ISBN-13. */
  q: z.string().optional(),
  isbn: z.string().optional(),
  sku: z.string().optional(),
  author: z.string().optional(),
  genre: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  /** Active books only when omitted. */
  is_active: z.enum(['true', 'false', 'all']).optional(),
  /** Lifecycle filter; when present it replaces `is_active`. */
  status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
  /** Whose price to show (any branch, #12); the session's branch when omitted. */
  branchId: OptionalIdQuerySchema,
  /** For /books/with-availability: whose stock to show. */
  locationId: OptionalIdQuerySchema,
  sortBy: z.enum(['title', 'isbn', 'created_at', 'default_price']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});
export type BookListQuery = z.infer<typeof BookListQuerySchema>;

export const BookListResponseSchema = z.object({
  items: z.array(BookSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type BookListResponse = z.infer<typeof BookListResponseSchema>;

export const BookAvailabilitySchema = z.object({
  locationId: z.number().int(),
  locationName: z.string().nullable(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
});

export const BookWithAvailabilitySchema = BookSchema.extend({
  /** Stock at `?locationId=`; null when no location was asked for. */
  availability: BookAvailabilitySchema.nullable(),
});

export const BookAvailabilityListResponseSchema = BookListResponseSchema.extend({
  items: z.array(BookWithAvailabilitySchema),
});
export type BookAvailabilityListResponse = z.infer<typeof BookAvailabilityListResponseSchema>;

export const CatalogSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Search for at least 2 characters'),
  limit: z.coerce
    .number()
    .int()
    .default(50)
    .transform((n) => Math.min(200, Math.max(1, n))),
  /** Whose price to show; the session's branch when omitted. */
  branchId: OptionalIdQuerySchema,
});

export const CatalogSearchResponseSchema = z.object({
  results: z.array(BookSchema),
  total: z.number().int().min(0),
});
export type CatalogSearchResponse = z.infer<typeof CatalogSearchResponseSchema>;

const IsbnInputSchema = z.string().min(10).max(17).optional().or(z.literal(''));

export const CreateBookRequestSchema = z.object({
  /** ISBN-13 or ISBN-10 (stored as ISBN-13); empty or omitted for a book without one. */
  isbn: IsbnInputSchema,
  sku: z.string().max(100).optional(),
  title: z.string().trim().min(1).max(500),
  /** Author names; existing authors are matched ignoring letter case, new ones are created. */
  authors: z.array(z.string().min(1)).default([]),
  /** Author ids; take precedence over `authors`. */
  authorIds: z.array(IdSchema).optional(),
  genre: z.string().max(100).optional(),
  publisher: z.string().max(200).optional(),
  publisherId: IdSchema.nullable().optional(),
  formatId: IdSchema.nullable().optional(),
  editionId: IdSchema.nullable().optional(),
  edition: z.string().max(50).optional(),
  language: z.string().max(50).optional(),
  format: z.string().max(50).optional(),
  description: z.string().max(5000).optional(),
  coverImageUrl: z.string().url().optional().or(z.literal('')),
  defaultPrice: z.number().nonnegative().optional(),
  tradeValue: z.number().nonnegative().optional(),
  /** Category names, matched like `authors`. */
  categories: z.array(z.string().min(1)).optional(),
  /** Category ids; take precedence over `categories`. */
  categoryIds: z.array(IdSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
});
export type CreateBookRequest = z.infer<typeof CreateBookRequestSchema>;

/** Only the fields given change; the ISBN cannot. */
export const UpdateBookRequestSchema = CreateBookRequestSchema.omit({ isbn: true }).partial();
export type UpdateBookRequest = z.infer<typeof UpdateBookRequestSchema>;

/** A catalog-only entry from the sale screens: no stock, the rest filled in later. */
export const QuickRegisterBookRequestSchema = z.object({
  isbn: IsbnInputSchema,
  title: z.string().trim().min(1).max(500),
  author: z.string().max(200).optional().or(z.literal('')),
  defaultPrice: z.number().nonnegative().optional(),
});
export type QuickRegisterBookRequest = z.infer<typeof QuickRegisterBookRequestSchema>;

export const BookBranchParamsSchema = z.object({ id: IdSchema, branchId: IdSchema });

export const BranchPriceRequestSchema = z.object({ price: z.number().nonnegative() });
export type BranchPriceRequest = z.infer<typeof BranchPriceRequestSchema>;

export const BookPriceListResponseSchema = z.object({
  items: z.array(z.object({ branchId: z.number().int(), branchName: z.string(), price: z.number() })),
});
export type BookPriceListResponse = z.infer<typeof BookPriceListResponseSchema>;

export const BookEditSchema = z.object({
  id: z.string(),
  bookId: z.number().int(),
  fieldName: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  changedBy: z.number().int(),
  changedByUsername: z.string().nullable(),
  changedAt: z.string(),
});
export type BookEdit = z.infer<typeof BookEditSchema>;

export const BookEditListResponseSchema = z.object({
  items: z.array(BookEditSchema),
  total: z.number().int().min(0),
});
export type BookEditListResponse = z.infer<typeof BookEditListResponseSchema>;

/** Records that use a book, by kind; any of them keeps it from being deleted. */
export const BookUsageSchema = z.record(z.string(), z.number().int());
export type BookUsage = z.infer<typeof BookUsageSchema>;

export const SuggestQuerySchema = z.object({ q: z.string().optional() });

export const SuggestResponseSchema = z.object({ items: z.array(z.string()) });
export type SuggestResponse = z.infer<typeof SuggestResponseSchema>;
