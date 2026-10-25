import type { DiscountType } from '../../../lib/discount.js';

export type { ReportFilters, ReportScope } from '../reportScope.js';

export type TransactionType = 'ORDER' | 'POS' | 'RETURN' | 'EXCHANGE';
/** What a line sold: copies of a book, or a service on them (#169). */
export type LineKind = 'BOOK' | 'SERVICE';
export type LinePaymentStatus = 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';

/**
 * One line of a sale, return or exchange: the rows behind the Sales Report,
 * its export and the Sales Performance figures (see salesLines.repository.ts).
 */
export interface SalesLineRecord {
  transactionDate: string;      // YYYY-MM-DD, in the database session's calendar
  transactionType: TransactionType;
  kind: LineKind;
  referenceNumber: string;
  branch: string;
  locationName: string;
  customerName: string;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;             // positive for ORDER/POS/EXCHANGE; negative for RETURN
  unitPrice: number;
  discountAmount: number;
  /** The discount's preset; null on return and exchange lines, which carry none. */
  discountType: DiscountType | null;
  grossAmount: number;
  netAmount: number;            // gross − discount for ORDER/POS; −refund for RETURN; ±allowance/sale for EXCHANGE
  costAmount: number;           // signed to match netAmount
  grossProfit: number;          // netAmount − costAmount
  paymentStatus: LinePaymentStatus;
  paymentMethod: string;
  cashCollected: number;        // invoice-level, repeated per line of that invoice
  receivableBalance: number;    // invoice-level, repeated per line of that invoice
  staffUsername: string;
}

/** The accrual figures: sums over the sales lines. */
export interface SalesSummary {
  grossSales: number;
  discounts: number;
  discountsByType: Record<DiscountType, number>;
  returnsValue: number;         // positive magnitude
  exchangeDifference: number;   // signed: outgoing − incoming across all exchange lines
  netSalesRevenue: number;      // grossSales − discounts − returnsValue + exchangeDifference
  /** Order and POS book lines after discount; with serviceIncome, what was sold before returns and exchanges. */
  bookSales: number;
  /** Order and POS service fees after discount (#169). */
  serviceIncome: number;
  costAmount: number;
  grossProfit: number;          // netSalesRevenue − costAmount
  grossMarginPct: number;       // grossProfit / netSalesRevenue × 100 (0 when netSalesRevenue is 0)
  rowCount: number;
}

/** The parts of the collected-cash profit, as the database sums them. */
export interface NetProfitParts {
  cashSalesRevenue: string;
  orderDiscounts: string;
  orderCost: string;
  posCost: string;
  returnsValue: string;
  returnsCost: string;
  exchangeAdjustment: string;
  collectedCreditRevenue: string;
  outstandingReceivables: string;
  posRevenue: string;
  posDiscounts: string;
}

/** Collected-cash profit (Cash & Receivables cards); see sales.policy netProfit(). */
export interface NetProfitResult {
  netProfit: number;
  fulfilledRevenue: number;     // cash orders + collected credit + cash POS
  purchaseCost: number;
  totalDiscounts: number;
  returnsValue: number;
  returnsCost: number;
  exchangeAdjustment: number;
  cashSalesRevenue: number;
  creditSalesRevenue: number;
  collectedCreditRevenue: number;
  outstandingReceivables: number;
}

export interface OrderTotalsRow {
  total_sales: string;
  total_orders: number;
  avg_order_value: string;
}
