import { z } from 'zod';
import { DateOnlySchema } from './common.js';

/**
 * Contracts for /api/v1/business-days and /api/v1/business-months (#175,
 * owner decisions 1a–6a, 2026-10-31): closing a branch's day and the shop's
 * month. Days are the shop's local days, in its business_timezone setting
 * (Africa/Addis_Ababa unless changed). A Manager, Admin or Finance_Officer
 * closes a branch's day once every cash session of it is closed; the day
 * report is kept, numbered DAY-, and nothing dated that day can be added or
 * changed in that branch. A Finance_Officer or Admin closes a month once every
 * branch has closed each day it worked in it. Only an Admin reopens, with a
 * reason; a day in a closed month reopens only after the month does.
 */

export const BusinessPeriodStatusSchema = z.enum(['open', 'closed', 'reopened']);
export type BusinessPeriodStatus = z.infer<typeof BusinessPeriodStatusSchema>;

/** A month, YYYY-MM. */
export const MonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month, YYYY-MM');

const amount = z.number();

/** The figures of a branch's day, as kept when it is closed. Amounts are in the shop's currency. */
export const DayReportSchema = z.object({
  sales: z.object({
    /** Orders confirmed that day, less those cancelled that day (their own day's minus). */
    orders: z.object({ count: z.number().int(), total: amount }),
    pos: z.object({ count: z.number().int(), total: amount }),
    exchanges: z.object({ count: z.number().int() }),
  }),
  /** Customer money in and out, and money paid to or refunded by suppliers, by method. */
  money: z.object({
    byMethod: z.array(z.object({ method: z.string(), in: amount, out: amount })),
    totalIn: amount,
    totalOut: amount,
  }),
  returns: z.object({ count: z.number().int(), refunded: amount }),
  /** Copies in and out at the branch's locations, by what moved them. */
  stock: z.array(z.object({ reason: z.string(), in: z.number().int(), out: z.number().int() })),
  /** The day's cash sessions and their counts. */
  cash: z.object({
    sessions: z.array(
      z.object({
        id: z.number().int(),
        zNumber: z.string().nullable(),
        staffName: z.string(),
        expected: amount,
        counted: amount,
        variance: amount,
      }),
    ),
    totalVariance: amount,
  }),
});
export type DayReport = z.infer<typeof DayReportSchema>;

const closing = {
  closedBy: z.number().int(),
  closedByName: z.string(),
  closedAt: z.string(),
  reopenedBy: z.number().int().nullable(),
  reopenedByName: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenReason: z.string().nullable(),
};

export const BusinessDaySchema = z.object({
  id: z.number().int(),
  branchId: z.number().int(),
  branchName: z.string(),
  day: z.string(),
  status: z.enum(['closed', 'reopened']),
  /** DAY-YYYYMMDD-NNNN, from the date it was (last) closed. */
  dayNumber: z.string(),
  ...closing,
});
export type BusinessDay = z.infer<typeof BusinessDaySchema>;

export const BusinessDayDetailSchema = BusinessDaySchema.extend({ report: DayReportSchema });
export type BusinessDayDetail = z.infer<typeof BusinessDayDetailSchema>;

export const BusinessDayListQuerySchema = z.object({ month: MonthSchema });
export type BusinessDayListQuery = z.infer<typeof BusinessDayListQuerySchema>;

export const BusinessDayListResponseSchema = z.object({ items: z.array(BusinessDaySchema) });
export type BusinessDayListResponse = z.infer<typeof BusinessDayListResponseSchema>;

export const DayQuerySchema = z.object({ day: DateOnlySchema });
export type DayQuery = z.infer<typeof DayQuerySchema>;

/** A day before it is closed: what it would keep, and what stops it closing. */
export const DayPreviewSchema = z.object({
  branchId: z.number().int(),
  day: z.string(),
  status: BusinessPeriodStatusSchema,
  businessDayId: z.number().int().nullable(),
  /** Sessions of the day still open or waiting for review. */
  openCashSessions: z.array(z.object({ id: z.number().int(), staffName: z.string(), status: z.string() })),
  monthClosed: z.boolean(),
  report: DayReportSchema,
});
export type DayPreview = z.infer<typeof DayPreviewSchema>;

export const CloseDayRequestSchema = z.object({ day: DateOnlySchema });
export type CloseDayRequest = z.infer<typeof CloseDayRequestSchema>;

export const ReopenRequestSchema = z.object({
  reason: z.string().trim().min(1, 'Say why it is reopened').max(500),
});
export type ReopenRequest = z.infer<typeof ReopenRequestSchema>;

/** One branch's month, summed from its closed days. */
export const MonthBranchSummarySchema = z.object({
  branchId: z.number().int(),
  branchName: z.string(),
  days: z.number().int(),
  sales: amount,
  moneyIn: amount,
  moneyOut: amount,
  refunded: amount,
  cashVariance: amount,
});
export type MonthBranchSummary = z.infer<typeof MonthBranchSummarySchema>;

export const MonthSummarySchema = z.object({
  branches: z.array(MonthBranchSummarySchema),
  totals: MonthBranchSummarySchema.omit({ branchId: true, branchName: true }),
});
export type MonthSummary = z.infer<typeof MonthSummarySchema>;

export const BusinessMonthSchema = z.object({
  id: z.number().int(),
  month: z.string(),
  status: z.enum(['closed', 'reopened']),
  ...closing,
});
export type BusinessMonth = z.infer<typeof BusinessMonthSchema>;

export const BusinessMonthDetailSchema = BusinessMonthSchema.extend({ summary: MonthSummarySchema });
export type BusinessMonthDetail = z.infer<typeof BusinessMonthDetailSchema>;

export const BusinessMonthListQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2999) });
export type BusinessMonthListQuery = z.infer<typeof BusinessMonthListQuerySchema>;

export const BusinessMonthListResponseSchema = z.object({ items: z.array(BusinessMonthSchema) });
export type BusinessMonthListResponse = z.infer<typeof BusinessMonthListResponseSchema>;

export const MonthQuerySchema = z.object({ month: MonthSchema });
export type MonthQuery = z.infer<typeof MonthQuerySchema>;

/** A month before it is closed: whether it has ended, the days each branch has still to close, and its summary so far. */
export const MonthPreviewSchema = z.object({
  month: z.string(),
  status: BusinessPeriodStatusSchema,
  businessMonthId: z.number().int().nullable(),
  ended: z.boolean(),
  openDays: z.array(z.object({ branchId: z.number().int(), branchName: z.string(), days: z.array(z.string()) })),
  summary: MonthSummarySchema,
});
export type MonthPreview = z.infer<typeof MonthPreviewSchema>;

export const CloseMonthRequestSchema = z.object({ month: MonthSchema });
export type CloseMonthRequest = z.infer<typeof CloseMonthRequestSchema>;
