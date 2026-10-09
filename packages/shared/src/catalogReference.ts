import { z } from 'zod';
import { IdSchema, LifecycleStatusSchema } from './common.js';

/**
 * Contracts for the catalog's reference data (#21): /api/v1/authors,
 * /categories, /publishers, /book-formats and /book-editions. Books link to
 * these; they are shared by every branch.
 */

export const AuthorSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  normalizedName: z.string(),
  status: LifecycleStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  /** In lists only: how many books name this author. */
  bookCount: z.number().int().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const CategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  normalizedName: z.string(),
  parentId: z.number().int().nullable(),
  /** In lists only. */
  parentName: z.string().nullable().optional(),
  status: LifecycleStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  /** In lists only: how many books are in this category. */
  bookCount: z.number().int().optional(),
});
export type Category = z.infer<typeof CategorySchema>;

export const PublisherSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: LifecycleStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  /** In lists only: how many books this publisher has. */
  bookCount: z.number().int().optional(),
});
export type Publisher = z.infer<typeof PublisherSchema>;

function listQuery(defaultPageSize: number, maxPageSize: number) {
  return z.object({
    /** Start of the name, any letter case. */
    q: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    // Pickers ask for more than the maximum; they get the maximum.
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .default(defaultPageSize)
      .transform((n) => Math.min(n, maxPageSize)),
    /** Lifecycle filter; active only when omitted. */
    status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
  });
}

export const AuthorListQuerySchema = listQuery(50, 100);
export const PublisherListQuerySchema = listQuery(50, 100);
export const CategoryListQuerySchema = listQuery(100, 200);
export type ReferenceListQuery = z.infer<typeof AuthorListQuerySchema>;

export const AuthorListResponseSchema = z.object({ items: z.array(AuthorSchema), total: z.number().int().min(0) });
export type AuthorListResponse = z.infer<typeof AuthorListResponseSchema>;
export const CategoryListResponseSchema = z.object({ items: z.array(CategorySchema), total: z.number().int().min(0) });
export type CategoryListResponse = z.infer<typeof CategoryListResponseSchema>;
export const PublisherListResponseSchema = z.object({ items: z.array(PublisherSchema), total: z.number().int().min(0) });
export type PublisherListResponse = z.infer<typeof PublisherListResponseSchema>;

const NameSchema = z.string().trim().min(1, 'Name is required').max(300);

export const ReferenceNameRequestSchema = z.object({ name: NameSchema });
export type ReferenceNameRequest = z.infer<typeof ReferenceNameRequestSchema>;

export const CreateCategoryRequestSchema = z.object({
  name: NameSchema,
  /** The category it sits under; null or omitted for a top-level category. */
  parentId: IdSchema.nullable().optional(),
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export const UpdateCategoryRequestSchema = CreateCategoryRequestSchema.partial();
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;

/** How many records use an author, category or publisher, by kind. */
export const ReferenceUsageSchema = z.record(z.string(), z.number().int());
export type ReferenceUsage = z.infer<typeof ReferenceUsageSchema>;

/** A fixed list entry: a book format or edition. */
export const BookLookupSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  label: z.string(),
  sortOrder: z.number().int(),
});
export type BookLookup = z.infer<typeof BookLookupSchema>;

export const BookLookupListResponseSchema = z.object({ items: z.array(BookLookupSchema) });
export type BookLookupListResponse = z.infer<typeof BookLookupListResponseSchema>;
