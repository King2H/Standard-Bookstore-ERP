import { z } from 'zod';
import { LifecycleStatusSchema, ListPagingQuerySchema, PaginatedSchema } from './common.js';

/**
 * Contracts for /api/v1/services (#169): non-stock items a sale carries next
 * to its books. Binding is the first kind: the shop binds a copy it sells in
 * the cover the service names.
 */

export const ServiceKindSchema = z.enum(['binding']);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

/** An amount in whole cents, as a JSON number or a decimal string. */
const AmountSchema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Must be an amount, e.g. "250.00"')])
  .refine((v) => typeof v === 'string' || Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
const FeeSchema = AmountSchema.refine((v) => Number(v) > 0, 'Must be more than zero');
const CostSchema = AmountSchema.refine((v) => Number(v) >= 0, 'Cannot be negative');

export const ServiceSchema = z.object({
  id: z.number().int(),
  /** Typed by staff, unique in the shop ignoring case; stored in capitals. */
  code: z.string(),
  name: z.string(),
  kind: ServiceKindSchema,
  /** The cover a binding produces (a book format). */
  formatId: z.number().int().nullable(),
  formatLabel: z.string().nullable(),
  /** The shop's fee. */
  fee: z.number(),
  /** The session branch's own fee, when it set one (owner decision 2a). */
  branchFee: z.number().nullable(),
  /** What the session branch charges: its own fee, else the shop's. */
  effectiveFee: z.number(),
  /** What one costs the shop, recorded on each sale; one for the whole shop. */
  standardCost: z.number(),
  /** Whether a sale may discount the fee (owner decision 3, #169). */
  discountable: z.boolean(),
  /** Days from the sale until the work is ready. */
  turnaroundDays: z.number().int(),
  status: LifecycleStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const ServiceListQuerySchema = ListPagingQuerySchema.extend({
  /** Code or name. */
  q: z.string().trim().max(100).optional(),
  /** Lifecycle filter; active only when omitted. */
  status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
});
export type ServiceListQuery = z.infer<typeof ServiceListQuerySchema>;

export const ServiceListResponseSchema = PaginatedSchema(ServiceSchema);
export type ServiceListResponse = z.infer<typeof ServiceListResponseSchema>;

/** A new service, or a whole service as it is to be (Admin, Manager). */
export const ServiceRequestSchema = z.object({
  code: z.string().trim().min(1, 'Required').max(30).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Letters, digits, - and _ only'),
  name: z.string().trim().min(1, 'Required').max(120),
  kind: ServiceKindSchema.default('binding'),
  formatId: z.number().int().positive(),
  fee: FeeSchema,
  standardCost: CostSchema,
  discountable: z.boolean().default(false),
  turnaroundDays: z.number().int().min(0).max(365),
});
export type ServiceRequest = z.infer<typeof ServiceRequestSchema>;

/** The session branch's own fee (owner decision 2a). */
export const ServiceBranchFeeRequestSchema = z.object({ fee: FeeSchema });
export type ServiceBranchFeeRequest = z.infer<typeof ServiceBranchFeeRequestSchema>;
