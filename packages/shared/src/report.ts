import { z } from 'zod';
import { DateOnlySchema, IdSchema } from './common.js';

/**
 * Contracts for /api/v1/reports (#22). Reports are read-only; the branch is
 * the session's, or any branch (or all) for staff with access to all
 * branches. Amounts are ETB numbers rounded to cents.
 */

/** A date range (both ends included) and the bucket size for series. */
export const ReportQuerySchema = z
  .object({
    branchId: IdSchema.optional(),
    dateFrom: DateOnlySchema.optional(),
    dateTo: DateOnlySchema.optional(),
    groupBy: z.enum(['day', 'week', 'month']).default('day'),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    message: 'dateFrom must not be after dateTo',
    path: ['dateTo'],
  });
export type ReportQuery = z.infer<typeof ReportQuerySchema>;

export const KpiQuerySchema = z.object({ branchId: IdSchema.optional() });

export const KpiPeriodSchema = z.enum(['today', 'week', 'month', 'year']);
export type KpiPeriod = z.infer<typeof KpiPeriodSchema>;

export const KpiPeriodQuerySchema = z.object({
  branchId: IdSchema.optional(),
  period: KpiPeriodSchema.default('today'),
});

// ── Sales ─────────────────────────────────────────────────────────────────────

export const SalesReportSchema = z.object({
  summary: z.object({
    /** Orders confirmed or later (drafts and cancelled orders are not sales). */
    totalSales: z.number(),
    totalOrders: z.number().int(),
    averageOrderValue: z.number(),
    totalPosSales: z.number(),
    totalPosTransactions: z.number().int(),
    /** Collected-cash view (Cash & Receivables cards). */
    netProfit: z.number(),
    purchaseCost: z.number(),
    totalDiscounts: z.number(),
    fulfilledRevenue: z.number(),
    outstandingReceivables: z.number(),
    cashSalesRevenue: z.number(),
    creditSalesRevenue: z.number(),
    /** Accrual view over the sales lines (Sales Performance cards, the export). */
    netSales: z.number(),
    grossProfit: z.number(),
    grossMarginPct: z.number(),
    costAmount: z.number(),
    grossSales: z.number(),
    discounts: z.number(),
    returnsValue: z.number(),
  }),
  byPeriod: z.array(
    z.object({ period: z.string(), totalSales: z.number(), totalOrders: z.number().int(), averageOrderValue: z.number() }),
  ),
  byBranch: z.array(
    z.object({ branchId: z.number().int(), branchName: z.string(), totalSales: z.number(), totalOrders: z.number().int() }),
  ),
});
export type SalesReport = z.infer<typeof SalesReportSchema>;

export const SalesSourceSchema = z.enum(['ORDER', 'POS', 'RETURN', 'EXCHANGE']);
export const SalesPaymentStatusSchema = z.enum(['PAID', 'PARTIALLY_PAID', 'UNPAID']);

/** One line of a sale, return or exchange. */
export const SalesLineSchema = z.object({
  date: z.string(),
  invoiceNo: z.string(),
  source: SalesSourceSchema,
  customer: z.string(),
  book: z.string(),
  /** Negative for a return. */
  qty: z.number().int(),
  unitPrice: z.number(),
  discount: z.number(),
  grossAmount: z.number(),
  returnAmount: z.number(),
  netSalesAmount: z.number(),
  costAmount: z.number(),
  grossProfit: z.number(),
  paymentStatus: SalesPaymentStatusSchema,
  /** The whole invoice's figures, repeated on each of its lines. */
  cashCollected: z.number(),
  receivableBalance: z.number(),
  branch: z.string(),
  location: z.string(),
  user: z.string(),
});
export type SalesLine = z.infer<typeof SalesLineSchema>;

export const SalesTotalsSchema = z.object({
  qty: z.number().int(),
  grossAmount: z.number(),
  returnAmount: z.number(),
  netSalesAmount: z.number(),
  costAmount: z.number(),
  grossProfit: z.number(),
  grossMarginPct: z.number(),
  cashCollected: z.number(),
  receivableBalance: z.number(),
});
export type SalesTotals = z.infer<typeof SalesTotalsSchema>;

export const SalesDetailResponseSchema = z.object({ rows: z.array(SalesLineSchema), totals: SalesTotalsSchema });

export const GrossProfitTrendSchema = z.array(
  z.object({ period: z.string(), netSales: z.number(), grossProfit: z.number(), grossMarginPct: z.number() }),
);

// ── KPIs ──────────────────────────────────────────────────────────────────────

export const KpiReportSchema = z.object({
  dailySales: z.number(),
  monthlySales: z.number(),
  dailyRevenue: z.number(),
  monthlyRevenue: z.number(),
  averageOrderValue: z.number(),
  totalActiveCustomers: z.number().int(),
  lowStockAlerts: z.number().int(),
  /** Confirmed orders not yet fulfilled. */
  pendingOrders: z.number().int(),
  totalExchangesToday: z.number().int(),
  outstandingBalance: z.number(),
  netProfit: z.number(),
  fulfilledRevenue: z.number(),
  outstandingReceivables: z.number(),
  cashSalesRevenue: z.number(),
  creditSalesRevenue: z.number(),
  collectedCreditRevenue: z.number(),
  purchaseCost: z.number(),
  totalDiscounts: z.number(),
  grossProfit: z.number(),
  dailyNetProfit: z.number(),
  monthlyNetProfit: z.number(),
  dailyNetSalesRevenue: z.number(),
  monthlyNetSalesRevenue: z.number(),
  dailyNetProfitUnified: z.number(),
  monthlyNetProfitUnified: z.number(),
  dailyGrossMarginPct: z.number(),
  monthlyGrossMarginPct: z.number(),
  grossProfitUnified: z.number(),
  overdueReceivablesAmount: z.number(),
  inventoryValue: z.number(),
});
export type KpiReport = z.infer<typeof KpiReportSchema>;

const PeriodFiguresSchema = z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
  netSales: z.number(),
  grossProfit: z.number(),
  grossMarginPct: z.number(),
});

export const PeriodKpisSchema = PeriodFiguresSchema.extend({
  period: KpiPeriodSchema,
  previous: PeriodFiguresSchema,
  /** Change against the previous equivalent period; null when that was 0. */
  netSalesChangePct: z.number().nullable(),
  grossProfitChangePct: z.number().nullable(),
  cashCollected: z.number(),
  previousCashCollected: z.number(),
});
export type PeriodKpis = z.infer<typeof PeriodKpisSchema>;
