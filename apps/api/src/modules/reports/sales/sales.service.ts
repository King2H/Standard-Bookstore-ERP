import { Money, type SalesLine, type SalesReport, type SalesTotals } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import * as policy from './sales.policy.js';
import * as sales from './sales.repository.js';
import { salesLines } from './salesLines.repository.js';
import { netProfitParts } from './netProfit.repository.js';
import type { NetProfitResult, ReportFilters, ReportScope, SalesSummary } from './sales.types.js';

/**
 * Sales report use cases (#22). Reports only read, on the report connection
 * (reportDb), so they need no transaction.
 */

const num = (v: string | number): number => Money.of(v).toNumber();

/** The accrual figures for a scope (also the KPIs' Sales Performance figures). */
export async function salesSummary(scope: ReportScope): Promise<SalesSummary> {
  return policy.summarizeLines(await salesLines(reportDb, scope));
}

/** The collected-cash profit for a scope (Cash & Receivables cards). */
export async function netProfit(scope: ReportScope): Promise<NetProfitResult> {
  return policy.netProfit(await netProfitParts(reportDb, scope));
}

export async function getSalesReport(filters: ReportFilters): Promise<SalesReport> {
  const scope: ReportScope = { branchId: filters.branchId, dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const [orders, pos, byPeriod, byBranch, profit, summary] = await Promise.all([
    sales.orderTotals(reportDb, scope),
    sales.posTotals(reportDb, scope),
    sales.orderTotalsByPeriod(reportDb, filters),
    sales.orderTotalsByBranch(reportDb, scope),
    netProfit(scope),
    salesSummary(scope),
  ]);
  return {
    summary: {
      totalSales: num(orders.total_sales),
      totalOrders: orders.total_orders,
      averageOrderValue: num(orders.avg_order_value),
      totalPosSales: num(pos.total_pos_sales),
      totalPosTransactions: pos.total_pos_transactions,
      netProfit: profit.netProfit,
      purchaseCost: profit.purchaseCost,
      totalDiscounts: profit.totalDiscounts,
      fulfilledRevenue: profit.fulfilledRevenue,
      outstandingReceivables: profit.outstandingReceivables,
      cashSalesRevenue: profit.cashSalesRevenue,
      creditSalesRevenue: profit.creditSalesRevenue,
      netSales: summary.netSalesRevenue,
      grossProfit: summary.grossProfit,
      grossMarginPct: summary.grossMarginPct,
      costAmount: summary.costAmount,
      grossSales: summary.grossSales,
      discounts: summary.discounts,
      returnsValue: summary.returnsValue,
    },
    byPeriod: byPeriod.map((r) => ({
      period: r.period,
      totalSales: num(r.total_sales),
      totalOrders: r.total_orders,
      averageOrderValue: num(r.avg_order_value),
    })),
    byBranch: byBranch.map((r) => ({
      branchId: r.branch_id,
      branchName: r.branch_name,
      totalSales: num(r.total_sales),
      totalOrders: r.total_orders,
    })),
  };
}

/** One row per line of a sale, return or exchange, with a totals row. */
export async function getSalesDetail(scope: ReportScope): Promise<{ rows: SalesLine[]; totals: SalesTotals }> {
  return policy.detailRows(await salesLines(reportDb, scope));
}

export async function getGrossProfitTrend(scope: ReportScope) {
  return policy.grossProfitTrend(await salesLines(reportDb, scope));
}
