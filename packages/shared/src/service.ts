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

// ── Services on a sale (#169 PR 2) ───────────────────────────────────────────

/**
 * A service on a book line of a sale or order (owner decision 1a): for some
 * or all of the line's copies (2a). The fee is the branch's; a discount is
 * taken only when the service allows it, within the cashier's line limit (3a).
 */
export const ServiceLineInputSchema = z.object({
  serviceId: z.number().int().positive(),
  quantity: z.number().int().positive(),
  /** 0 to 100, with discountMode Percentage (the default). */
  discountPct: z.number().min(0).max(100).optional(),
  /** With discountMode Amount: the line's discount in money, at most its value. */
  discountAmount: z.number().min(0).optional(),
  discountMode: z.enum(['Percentage', 'Amount']).optional(),
});
export type ServiceLineInput = z.infer<typeof ServiceLineInputSchema>;

export const ServiceJobStatusSchema = z.enum(['REQUESTED', 'AT_BINDER', 'READY', 'COLLECTED', 'CANCELLED']);
export type ServiceJobStatus = z.infer<typeof ServiceJobStatusSchema>;

/** The work a service line asks for (4a), opened at the sale, or at an order's confirmation (5a). */
export const ServiceJobSchema = z.object({
  /** A bigint, sent as a number. */
  id: z.number().int(),
  /** SVC-YYYYMMDD-NNNN. */
  jobNumber: z.string(),
  status: ServiceJobStatusSchema,
  /** The sale's day plus the service's turnaround, YYYY-MM-DD. */
  readyDate: z.string(),
  /** Who is called when it is ready. */
  customerId: z.number().int(),
  branchId: z.number().int(),
  updatedAt: z.string(),
});
export type ServiceJob = z.infer<typeof ServiceJobSchema>;

/** A service line as the sale recorded it: what was charged and what it cost. */
export const SaleServiceLineSchema = z.object({
  id: z.number().int(),
  serviceId: z.number().int(),
  serviceCode: z.string(),
  serviceName: z.string(),
  quantity: z.number().int(),
  unitFee: z.number(),
  discountAmount: z.number(),
  lineTotal: z.number(),
  /** The service's standard cost per copy, frozen at the sale. */
  standardCost: z.number(),
  /** Null on an order not yet confirmed. */
  job: ServiceJobSchema.nullable(),
});
export type SaleServiceLine = z.infer<typeof SaleServiceLineSchema>;

/** A job's next step: to the binder, back and ready, handed to the customer. */
export const ServiceJobStepSchema = z.enum(['send', 'ready', 'collect']);
export type ServiceJobStep = z.infer<typeof ServiceJobStepSchema>;

export const ServiceJobStepParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  step: ServiceJobStepSchema,
});
