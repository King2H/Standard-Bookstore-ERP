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

// ── Inventory ─────────────────────────────────────────────────────────────────

export const InventoryReportSchema = z.object({
  /** Stock now, not a period flow. */
  summary: z.object({
    totalBooks: z.number().int(),
    totalStockUnits: z.number().int(),
    availableStock: z.number().int(),
    reservedStock: z.number().int(),
    lowStockItems: z.number().int(),
    outOfStockItems: z.number().int(),
  }),
  lowStockItems: z.array(
    z.object({
      bookId: z.number().int(),
      title: z.string(),
      locationId: z.number().int(),
      locationName: z.string(),
      quantity: z.number().int(),
      reorderPoint: z.number().int(),
    }),
  ),
  /** POS sales in the range. */
  topSellingBooks: z.array(z.object({ bookId: z.number().int(), title: z.string(), unitsSold: z.number().int(), revenue: z.number() })),
  stockMovement: z.array(z.object({ period: z.string(), stockIn: z.number().int(), stockOut: z.number().int() })),
});
export type InventoryReport = z.infer<typeof InventoryReportSchema>;

// ── Customers ─────────────────────────────────────────────────────────────────

export const CustomerReportSchema = z.object({
  summary: z.object({
    totalCustomers: z.number().int(),
    activeCustomers: z.number().int(),
    /** Customers with more than one sale (orders confirmed or later) in the range. */
    repeatCustomers: z.number().int(),
    newCustomersInPeriod: z.number().int(),
  }),
  /** By spend on orders confirmed or later in the range. */
  topCustomers: z.array(z.object({ customerId: z.number().int(), fullName: z.string(), totalSpend: z.number(), orderCount: z.number().int() })),
  byPeriod: z.array(z.object({ period: z.string(), newCustomers: z.number().int() })),
});
export type CustomerReport = z.infer<typeof CustomerReportSchema>;

// ── Receivables ───────────────────────────────────────────────────────────────

export const AgingBucketSchema = z.enum(['Current', '1-30', '31-60', '61-90', '90+']);
export type AgingBucket = z.infer<typeof AgingBucketSchema>;

export const ReceivablesAgingRowSchema = z.object({
  customer: z.string(),
  invoiceNo: z.string(),
  invoiceDate: z.string(),
  dueDate: z.string(),
  outstandingAmount: z.number(),
  agingBucket: AgingBucketSchema,
  lastPaymentDate: z.string(),
});

/** Open receivables by days past due; a balance now, so the date range does not apply. */
export const ReceivablesAgingSchema = z.object({
  rows: z.array(ReceivablesAgingRowSchema),
  byBucket: z.array(z.object({ bucket: AgingBucketSchema, count: z.number().int(), totalOutstanding: z.number() })),
});
export type ReceivablesAging = z.infer<typeof ReceivablesAgingSchema>;
