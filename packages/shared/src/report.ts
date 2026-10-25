import { z } from 'zod';
import { DateOnlySchema, IdSchema } from './common.js';

/**
 * Contracts for /api/v1/reports (#22). Reports are read-only; the branch is
 * the session's, or any branch (or all) for staff with access to all
 * branches. Amounts are ETB numbers rounded to cents.
 */

const ReportQueryFields = z.object({
  branchId: IdSchema.optional(),
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
});

const rangeInOrder = (q: { dateFrom?: string; dateTo?: string }) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo;
const rangeMessage = { message: 'dateFrom must not be after dateTo', path: ['dateTo'] };

/** A date range (both ends included) and the bucket size for series. */
export const ReportQuerySchema = ReportQueryFields.refine(rangeInOrder, rangeMessage);
export type ReportQuery = z.infer<typeof ReportQuerySchema>;

/** The report query and how many rows to list (the top N). */
export const TopReportQuerySchema = ReportQueryFields.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).refine(rangeInOrder, rangeMessage);

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
    /** The discounts by the preset the line used; they add up to discounts. */
    discountsByType: z.object({ Normal: z.number(), Merchant: z.number(), Special: z.number() }),
    returnsValue: z.number(),
    /** Book lines of orders and counter sales, after discount (#169). */
    bookSales: z.number(),
    /** Service fees of orders and counter sales, after discount (#169). */
    serviceIncome: z.number(),
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
  /** Copies of a book, or a service on them (#169): the service's name with the book's title. */
  kind: z.enum(['BOOK', 'SERVICE']),
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

/** Per day, week or month (groupBy); period is the bucket's first day, YYYY-MM-DD. */
export const GrossProfitTrendSchema = z.array(
  z.object({ period: z.string(), netSales: z.number(), grossProfit: z.number(), grossMarginPct: z.number() }),
);
export type GrossProfitTrend = z.infer<typeof GrossProfitTrendSchema>;

// ── KPIs ──────────────────────────────────────────────────────────────────────

export const KpiReportSchema = z.object({
  dailySales: z.number(),
  monthlySales: z.number(),
  /** Cash collected today and this month, net of refunds, as the Payments report counts it. */
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
  /**
   * Customer money for the period, as the Payments report counts it: money
   * in (payments), money out (refunds), and what is left (in less out).
   */
  cashIn: z.number(),
  cashOut: z.number(),
  cashCollected: z.number(),
  /** What was left in the previous equivalent period. */
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

// ── Payments ──────────────────────────────────────────────────────────────────

/**
 * Customer money in and out (owner decision, #22): order, POS and exchange
 * payments in; order refunds, return refunds and exchange refunds out. Voided
 * sales and exchanges are left out (their money went back).
 */
export const PaymentReportSchema = z.object({
  summary: z.object({
    totalCollected: z.number(),
    totalRefunded: z.number(),
    netCollected: z.number(),
    /** Order payments not yet confirmed. */
    pendingPayments: z.number(),
  }),
  /** Money in by method code (cash, bank, mobile, store_credit, ...). */
  byMethod: z.array(z.object({ method: z.string(), total: z.number(), count: z.number().int() })),
  byPeriod: z.array(z.object({ period: z.string(), collected: z.number(), refunded: z.number() })),
});
export type PaymentReport = z.infer<typeof PaymentReportSchema>;

export const PaymentsLedgerRowSchema = z.object({
  receiptNo: z.string(),
  party: z.string(),
  referenceType: z.enum(['ORDER', 'POS', 'RETURN', 'EXCHANGE', 'PO']),
  referenceNo: z.string(),
  paymentMethod: z.string(),
  /** The bank the customer paid from; empty when not a bank payment or not recorded. */
  payerBank: z.string(),
  /** A bank transfer's reference or a Telebirr transaction number; empty when none. */
  paymentReference: z.string(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  date: z.string(),
  user: z.string(),
});
export type PaymentsLedgerRow = z.infer<typeof PaymentsLedgerRowSchema>;

/** Every receipt and payment: customers in and out, suppliers out. */
export const PaymentsLedgerSchema = z.object({ rows: z.array(PaymentsLedgerRowSchema) });
export type PaymentsLedger = z.infer<typeof PaymentsLedgerSchema>;

// ── Exchanges ─────────────────────────────────────────────────────────────────

/** Completed exchanges in the range (voided ones are left out). */
export const ExchangeReportSchema = z.object({
  summary: z.object({
    totalExchanges: z.number().int(),
    totalIncomingValue: z.number(),
    totalOutgoingValue: z.number(),
    netExchangeImpact: z.number(),
  }),
  bySettlementType: z.array(z.object({ settlementType: z.string(), count: z.number().int(), totalNetBalance: z.number() })),
  byPeriod: z.array(z.object({ period: z.string(), count: z.number().int(), incomingValue: z.number(), outgoingValue: z.number() })),
});
export type ExchangeReport = z.infer<typeof ExchangeReportSchema>;

export const ExchangeDetailRowSchema = z.object({
  exchangeNo: z.string(),
  customer: z.string(),
  incomingBook: z.string(),
  incomingValue: z.number(),
  outgoingBook: z.string(),
  outgoingValue: z.number(),
  difference: z.number(),
  differencePaymentStatus: z.string(),
  cashCollected: z.number(),
  receivableBalance: z.number(),
  date: z.string(),
  user: z.string(),
});
export type ExchangeDetailRow = z.infer<typeof ExchangeDetailRowSchema>;

export const ExchangeDetailResponseSchema = z.object({ rows: z.array(ExchangeDetailRowSchema) });

// ── Returns ───────────────────────────────────────────────────────────────────

export const ReturnReportRowSchema = z.object({
  returnNo: z.string(),
  originalInvoiceNo: z.string(),
  customer: z.string(),
  book: z.string(),
  qtyReturned: z.number().int(),
  refundAmount: z.number(),
  originalCost: z.number(),
  /** The margin the sale made, now given back. */
  profitReversed: z.number(),
  refundMethod: z.string(),
  returnDate: z.string(),
  user: z.string(),
});
export type ReturnReportRow = z.infer<typeof ReturnReportRowSchema>;

export const ReturnReportResponseSchema = z.object({ rows: z.array(ReturnReportRowSchema) });

export const TopReturnedBooksSchema = z.array(
  z.object({ bookId: z.number().int(), title: z.string(), unitsReturned: z.number().int(), refundValue: z.number() }),
);
export type TopReturnedBooks = z.infer<typeof TopReturnedBooksSchema>;

// ── Procurement ───────────────────────────────────────────────────────────────

export const OpenPurchaseOrdersSchema = z.array(
  z.object({
    poReference: z.string(),
    supplier: z.string(),
    orderDate: z.string(),
    expectedDate: z.string(),
    orderedQty: z.number().int(),
    receivedQty: z.number().int(),
    totalAmount: z.number(),
    /** What was received less what was paid and credited. */
    outstandingAmount: z.number(),
    receiptStatus: z.string(),
    paymentStatus: z.string(),
  }),
);

export const SupplierBalancesSchema = z.array(
  z.object({
    supplierId: z.number().int(),
    supplier: z.string(),
    openPoCount: z.number().int(),
    receivedValue: z.number(),
    paid: z.number(),
    credited: z.number(),
    outstandingBalance: z.number(),
  }),
);

/** What is owed to suppliers, by days since the goods arrived. */
export const ApAgingSchema = z.object({
  rows: z.array(
    z.object({
      supplier: z.string(),
      poReference: z.string(),
      outstandingAmount: z.number(),
      agingBucket: AgingBucketSchema,
      lastReceiptDate: z.string(),
    }),
  ),
  byBucket: z.array(z.object({ bucket: AgingBucketSchema, count: z.number().int(), totalOutstanding: z.number() })),
});

export const PurchasesBySupplierSchema = z.array(
  z.object({ supplierId: z.number().int(), supplier: z.string(), poCount: z.number().int(), orderedValue: z.number(), receivedValue: z.number() }),
);

export const PurchasesByBookSchema = z.array(
  z.object({
    bookId: z.number().int(),
    title: z.string(),
    isbn: z.string(),
    orderedQty: z.number().int(),
    receivedQty: z.number().int(),
    totalValue: z.number(),
  }),
);

export const SupplierPaymentHistorySchema = z.array(
  z.object({
    date: z.string(),
    supplier: z.string(),
    poReference: z.string(),
    amount: z.number(),
    paymentMethod: z.string(),
    source: z.string(),
    user: z.string(),
  }),
);
