import {
  CustomerReportSchema, ExchangeReportSchema, GrossProfitTrendSchema, InventoryReportSchema, PaymentReportSchema,
  ReceivablesAgingSchema, SalesReportSchema, TopReturnedBooksSchema,
  type SalesReport,
} from '@bms/shared';
import { contract } from './contract.js';

// Empty answers for the report endpoints the Dashboard reads, checked against
// their contracts, for tests that only care about some of them.

const ZERO_SALES_SUMMARY = Object.fromEntries(
  Object.keys(SalesReportSchema.shape.summary.shape).map((k) => [k, 0]),
) as unknown as SalesReport['summary'];

export const EMPTY_REPORTS = {
  sales: contract(SalesReportSchema, {
    summary: { ...ZERO_SALES_SUMMARY, discountsByType: { Normal: 0, Merchant: 0, Special: 0 } }, byPeriod: [], byBranch: [],
  }),
  payments: contract(PaymentReportSchema, {
    summary: { totalCollected: 0, totalRefunded: 0, netCollected: 0, pendingPayments: 0 }, byMethod: [], byPeriod: [],
  }),
  exchanges: contract(ExchangeReportSchema, {
    summary: { totalExchanges: 0, totalIncomingValue: 0, totalOutgoingValue: 0, netExchangeImpact: 0 }, bySettlementType: [], byPeriod: [],
  }),
  customers: contract(CustomerReportSchema, {
    summary: { totalCustomers: 0, activeCustomers: 0, repeatCustomers: 0, newCustomersInPeriod: 0 }, topCustomers: [], byPeriod: [],
  }),
  inventory: contract(InventoryReportSchema, {
    summary: { totalBooks: 0, totalStockUnits: 0, availableStock: 0, reservedStock: 0, lowStockItems: 0, outOfStockItems: 0 },
    lowStockItems: [], topSellingBooks: [], stockMovement: [],
  }),
  'receivables-aging': contract(ReceivablesAgingSchema, { rows: [], byBucket: [] }),
  'sales/gross-profit-trend': contract(GrossProfitTrendSchema, []),
  'returns/top': contract(TopReturnedBooksSchema, []),
};

/** The empty answer for a report path such as `/reports/sales?groupBy=day`, or undefined if it is not one. */
export function emptyReport(path: string): unknown {
  const name = path.split('?')[0].replace(/^\/reports\//, '');
  return (EMPTY_REPORTS as Record<string, unknown>)[name];
}
