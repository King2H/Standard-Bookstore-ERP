import { z } from 'zod';

/**
 * Building blocks shared by every API contract (ADR-0004). Domain schemas live
 * in `<domain>.ts` next to this file and arrive with each module's refactor.
 */

/** A database id from a route parameter or query string ("12" -> 12). */
export const IdSchema = z.coerce.number().int().positive();

/** `/:id` route parameters. */
export const IdParamsSchema = z.object({ id: IdSchema });
export type IdParams = z.infer<typeof IdParamsSchema>;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** `?page=&pageSize=` for list endpoints. */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * `?page=&pageSize=` for list endpoints whose existing clients ask for more
 * than MAX_PAGE_SIZE (pickers that load "everything"): larger page sizes are
 * capped instead of rejected.
 */
export const ListPagingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_PAGE_SIZE)
    .transform((n) => Math.min(n, MAX_PAGE_SIZE)),
});

/** List response wrapper: `PaginatedSchema(BookSchema)`. */
export function PaginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalPages: z.number().int().min(0),
  });
}

/** Lifecycle of master data (books, suppliers, customers, ...). */
export const LifecycleStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/** Response of actions that return only a confirmation, e.g. `{ message: 'Supplier archived' }`. */
export const MessageResponseSchema = z.object({ message: z.string() });
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

/**
 * A money amount in a request: a JSON number (19.99) or a decimal string
 * ("19.99"), up to 4 decimals. Services turn it into `Money` for arithmetic.
 */
export const MoneyInputSchema = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'Must be a decimal amount, e.g. "19.99"'),
]);

/**
 * The error envelope every API error uses. `error` is a stable code from
 * docs/v2/api-errors.md; `message` is for people and may change.
 */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
  requestId: z.string(),
  timestamp: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
