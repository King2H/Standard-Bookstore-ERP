import { z } from 'zod';
import { DateOnlySchema, IdSchema, MoneyInputSchema, PaginatedSchema, PaginationQuerySchema } from './common.js';

/**
 * Contracts for /api/v1/cash-sessions (#171): the cash a staff member holds
 * at the counter, from an opening float to a count at close. No tills: a
 * session is one person's in one branch, as a shop with one salesperson and
 * no counter keeps it. The counter's money (sales, collections, refunds,
 * voids) is recorded on the open session; cash put in or taken out is
 * recorded with a reason. Closing counts the cash blind; over or short beyond
 * the branch's limit waits for a Manager or Admin.
 */

export const CashSessionStatusSchema = z.enum(['open', 'pending_review', 'closed']);
export type CashSessionStatus = z.infer<typeof CashSessionStatusSchema>;

/** What moved the money: a counter flow, or cash put in or taken out by hand. */
export const CashMovementKindSchema = z.enum([
  'pos_payment',
  'pos_void',
  'order_payment',
  'order_refund',
  'receivable_payment',
  'return_refund',
  'exchange_payment',
  'exchange_refund',
  'exchange_void',
  'pay_in',
  'pay_out',
]);
export type CashMovementKind = z.infer<typeof CashMovementKindSchema>;

/** Why cash was put in or taken out by hand. */
export const PAY_IN_CATEGORIES = ['float_top_up', 'other'] as const;
export const PAY_OUT_CATEGORIES = ['bank_drop', 'petty_cash', 'other'] as const;
export const CashMovementCategorySchema = z.enum(['float_top_up', 'bank_drop', 'petty_cash', 'other']);
export type CashMovementCategory = z.infer<typeof CashMovementCategorySchema>;

export const CashMovementSchema = z.object({
  id: z.number().int(),
  kind: CashMovementKindSchema,
  /** The payment, refund or entry it records; null when put in or taken out by hand. */
  sourceId: z.string().nullable(),
  /** cash, bank or mobile; only cash is in the drawer. */
  method: z.string(),
  direction: z.enum(['in', 'out']),
  amount: z.number(),
  category: CashMovementCategorySchema.nullable(),
  reason: z.string().nullable(),
  staffId: z.number().int(),
  staffName: z.string(),
  createdAt: z.string(),
});
export type CashMovement = z.infer<typeof CashMovementSchema>;

/** One line of the X or Z report: what moved by one kind and method. */
export const CashSessionTotalSchema = z.object({
  kind: CashMovementKindSchema,
  method: z.string(),
  direction: z.enum(['in', 'out']),
  count: z.number().int(),
  amount: z.number(),
});
export type CashSessionTotal = z.infer<typeof CashSessionTotalSchema>;

export const CashSessionSchema = z.object({
  id: z.number().int(),
  branchId: z.number().int(),
  branchName: z.string(),
  staffId: z.number().int(),
  staffName: z.string(),
  status: CashSessionStatusSchema,
  currency: z.string(),
  openingFloat: z.number(),
  openedAt: z.string(),
  /**
   * Float plus cash in less cash out. Hidden (null) from the session's own
   * staff member while it is open, so the count at close is blind; shown to
   * a Manager or Admin, and to everyone once closed.
   */
  expectedCash: z.number().nullable(),
  countedCash: z.number().nullable(),
  /** Counted less expected: over when positive, short when negative. */
  variance: z.number().nullable(),
  closeNote: z.string().nullable(),
  closedBy: z.number().int().nullable(),
  closedByName: z.string().nullable(),
  closedAt: z.string().nullable(),
  reviewedBy: z.number().int().nullable(),
  reviewedByName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewReason: z.string().nullable(),
  /** Z-YYYYMMDD-NNNN, given at close. */
  zNumber: z.string().nullable(),
});
export type CashSession = z.infer<typeof CashSessionSchema>;

/**
 * A session with its report: the totals by kind and method, and every
 * movement. While it is open, its own staff member sees only the cash they
 * put in or took out, and no totals.
 */
export const CashSessionDetailSchema = CashSessionSchema.extend({
  totals: z.array(CashSessionTotalSchema).nullable(),
  movements: z.array(CashMovementSchema),
});
export type CashSessionDetail = z.infer<typeof CashSessionDetailSchema>;

/** The signed-in staff member's open session in the session branch, and whether the branch needs one for cash. */
export const CurrentCashSessionResponseSchema = z.object({
  required: z.boolean(),
  session: CashSessionDetailSchema.nullable(),
});
export type CurrentCashSessionResponse = z.infer<typeof CurrentCashSessionResponseSchema>;

export const CashSessionListQuerySchema = PaginationQuerySchema.extend({
  status: CashSessionStatusSchema.optional(),
  /** One staff member's sessions; a staff member who may not see others' sees only their own. */
  staffId: IdSchema.optional(),
  /** Opened on or after this day. */
  dateFrom: DateOnlySchema.optional(),
  /** Opened on or before this day. */
  dateTo: DateOnlySchema.optional(),
});
export type CashSessionListQuery = z.infer<typeof CashSessionListQuerySchema>;

export const CashSessionListResponseSchema = PaginatedSchema(CashSessionSchema);
export type CashSessionListResponse = z.infer<typeof CashSessionListResponseSchema>;

const CashAmountSchema = MoneyInputSchema.refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), 'Must be an amount of at most two decimals, not negative');
const PositiveCashSchema = CashAmountSchema.refine((v) => Number(v) > 0, 'Must be more than zero');
const ReasonSchema = z.string().trim().min(1, 'A reason is required').max(500);

export const OpenCashSessionRequestSchema = z.object({
  /** The cash in the drawer at the start; 0 when it starts empty. */
  openingFloat: CashAmountSchema,
});
export type OpenCashSessionRequest = z.infer<typeof OpenCashSessionRequestSchema>;

/** Cash put in (float top-up, other) or taken out (bank drop, petty cash, other) by hand, with a reason. */
export const CashMovementRequestSchema = z
  .object({
    direction: z.enum(['in', 'out']),
    category: CashMovementCategorySchema,
    amount: PositiveCashSchema,
    reason: ReasonSchema,
  })
  .refine(
    (m) => (m.direction === 'in' ? (PAY_IN_CATEGORIES as readonly string[]) : (PAY_OUT_CATEGORIES as readonly string[])).includes(m.category),
    { message: 'Cash put in is a float top-up or other; cash taken out is a bank drop, petty cash or other', path: ['category'] },
  );
export type CashMovementRequest = z.infer<typeof CashMovementRequestSchema>;

/** The cash counted in the drawer, without being shown what is expected. */
export const CloseCashSessionRequestSchema = z.object({
  countedCash: CashAmountSchema,
  note: z.string().trim().max(1000).nullable().optional(),
});
export type CloseCashSessionRequest = z.infer<typeof CloseCashSessionRequestSchema>;

/** A Manager or Admin accepts a count over or short beyond the limit, saying why. */
export const ReviewCashSessionRequestSchema = z.object({ reason: ReasonSchema });
export type ReviewCashSessionRequest = z.infer<typeof ReviewCashSessionRequestSchema>;
