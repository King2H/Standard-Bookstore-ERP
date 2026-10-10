import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, MoneyInputSchema } from './common.js';

/** Contracts for /api/v1/receivables: what customers owe on credit sales and exchanges (#21). */

/**
 * Pending, PartiallyPaid and Overdue are still owed. Settled was paid in full;
 * WrittenOff was closed as a bad debt, without payment; Cancelled went with
 * its sale (a voided POS sale, a cancelled order).
 */
export const ReceivableStatusSchema = z.enum(['Pending', 'PartiallyPaid', 'Settled', 'Overdue', 'WrittenOff', 'Cancelled']);
export type ReceivableStatus = z.infer<typeof ReceivableStatusSchema>;

export const ReceivableSourceTypeSchema = z.enum(['pos_credit_sale', 'exchange_difference', 'order_credit_sale']);
export type ReceivableSourceType = z.infer<typeof ReceivableSourceTypeSchema>;

export const ReceivableSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  sourceType: ReceivableSourceTypeSchema,
  /** The sale's or exchange's number, e.g. TXN-… */
  sourceRefId: z.string(),
  /** The order, POS transaction or exchange id. */
  sourceEntityId: z.string(),
  customerId: z.number().int(),
  customerName: z.string().nullable(),
  customerCode: z.string().nullable(),
  branchId: z.number().int(),
  originalAmount: z.number(),
  outstandingAmount: z.number(),
  currency: z.string(),
  /** YYYY-MM-DD. */
  dueDate: z.string().nullable(),
  /** When it was paid in full. */
  settlementDate: z.string().nullable(),
  status: ReceivableStatusSchema,
  notes: z.string().nullable(),
  /** What was still owed when it was written off. */
  writtenOffAmount: z.number().nullable(),
  writtenOffAt: z.string().nullable(),
  writtenOffBy: z.number().int().nullable(),
  writeOffReason: z.string().nullable(),
  /** What was still owed when its sale was cancelled. */
  cancelledAmount: z.number().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Receivable = z.infer<typeof ReceivableSchema>;

/** A calendar date, YYYY-MM-DD, that exists (not 2026-02-31). */
const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a calendar date');

export const ReceivableListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  /** One status, or several separated by commas: "Pending,PartiallyPaid,Overdue". */
  status: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(ReceivableStatusSchema))
    .optional(),
  sourceType: ReceivableSourceTypeSchema.optional(),
  dueDateFrom: DateOnlySchema.optional(),
  dueDateTo: DateOnlySchema.optional(),
  overdueOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ReceivableListQuery = z.infer<typeof ReceivableListQuerySchema>;

export const ReceivableListResponseSchema = z.object({
  items: z.array(ReceivableSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type ReceivableListResponse = z.infer<typeof ReceivableListResponseSchema>;

export const ReceivableSummarySchema = z.object({
  totalOutstanding: z.number(),
  pendingCount: z.number().int(),
  overdueCount: z.number().int(),
  partiallyPaidCount: z.number().int(),
  settledThisMonth: z.number().int(),
  writtenOffThisMonth: z.number().int(),
});
export type ReceivableSummary = z.infer<typeof ReceivableSummarySchema>;

export const CollectReceivableRequestSchema = z.object({
  amount: MoneyInputSchema,
  paymentMethod: z.enum(['cash', 'bank', 'mobile', 'store_credit']),
  /** Required for bank. */
  bankAccountId: IdSchema.nullable().optional(),
  notes: z.string().max(1000).optional(),
});
export type CollectReceivableRequest = z.infer<typeof CollectReceivableRequestSchema>;

export const WriteOffReceivableRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
});
export type WriteOffReceivableRequest = z.infer<typeof WriteOffReceivableRequestSchema>;

export const ReceivableDueDateRequestSchema = z.object({
  /** Null removes the due date. */
  dueDate: DateOnlySchema.nullable(),
});
export type ReceivableDueDateRequest = z.infer<typeof ReceivableDueDateRequestSchema>;
