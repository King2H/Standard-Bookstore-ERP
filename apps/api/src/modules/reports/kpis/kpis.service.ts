import { Money, type KpiPeriod, type KpiReport, type PeriodKpis } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import { salesSummary } from '../sales/sales.service.js';
import { pctChange } from '../sales/sales.policy.js';
import { moneyTotals } from '../payments/paymentReports.repository.js';
import * as kpis from './kpis.repository.js';
import * as policy from './kpis.policy.js';

/** Dashboard KPI use cases (#22), read on the report connection. */

/**
 * Customer money in a period: what came in, what went back, and what is left,
 * as the Payments report counts it (owner decision, 2026-10-23), so the
 * dashboard and the report agree.
 */
async function cash(branchId: number | undefined, dateFrom: string, dateTo: string) {
  const m = await moneyTotals(reportDb, { branchId, dateFrom, dateTo });
  return { cashIn: policy.total(m.collected), cashOut: policy.total(m.refunded), net: Money.of(m.collected).minus(m.refunded).toNumber() };
}

export async function getKpis(branchId: number | undefined): Promise<KpiReport> {
  const cal = await kpis.calendar(reportDb);
  const today = { branchId, dateFrom: cal.today, dateTo: cal.today };
  const month = { branchId, dateFrom: cal.month_start, dateTo: cal.today };
  const [f, daily, monthly, todayCash, monthCash] = await Promise.all([
    kpis.kpiFigures(reportDb, branchId),
    salesSummary(today),
    salesSummary(month),
    cash(branchId, today.dateFrom, today.dateTo),
    cash(branchId, month.dateFrom, month.dateTo),
  ]);
  return {
    dailySales: policy.total(f.dailyOrderSales, f.dailyPosSales, f.dailyExchangeSales),
    monthlySales: policy.total(f.monthlyOrderSales, f.monthlyPosSales, f.monthlyExchangeSales),
    // Cash collected, net of refunds.
    dailyRevenue: todayCash.net,
    monthlyRevenue: monthCash.net,
    averageOrderValue: policy.total(f.averageOrderValue),
    totalActiveCustomers: f.activeCustomers,
    lowStockItems: f.lowStockItems,
    outOfStockItems: f.outOfStockItems,
    pendingOrders: f.pendingOrders,
    totalExchangesToday: f.exchangesToday,
    outstandingBalance: policy.total(f.outstanding),
    // The shop's one profit (#230, 1b): over the sales lines, by the day of the sale.
    dailyNetSalesRevenue: daily.netSalesRevenue,
    monthlyNetSalesRevenue: monthly.netSalesRevenue,
    dailyNetProfitUnified: daily.grossProfit,
    monthlyNetProfitUnified: monthly.grossProfit,
    dailyGrossMarginPct: daily.grossMarginPct,
    monthlyGrossMarginPct: monthly.grossMarginPct,
    grossProfitUnified: monthly.grossProfit,
    overdueReceivablesAmount: policy.total(f.overdue),
    inventoryValue: policy.total(f.inventoryValue),
    inventoryInTransit: policy.total(f.inventoryInTransit),
  };
}

/** Sales Performance for a period so far, against the previous equivalent period. */
export async function getPeriodKpis(branchId: number | undefined, period: KpiPeriod): Promise<PeriodKpis> {
  const r = policy.periodRange(period, await kpis.calendar(reportDb));
  const [current, previous, now, before] = await Promise.all([
    salesSummary({ branchId, dateFrom: r.dateFrom, dateTo: r.dateTo }),
    salesSummary({ branchId, dateFrom: r.prevFrom, dateTo: r.prevTo }),
    cash(branchId, r.dateFrom, r.dateTo),
    cash(branchId, r.prevFrom, r.prevTo),
  ]);
  return {
    period,
    dateFrom: r.dateFrom,
    dateTo: r.dateTo,
    netSales: current.netSalesRevenue,
    grossProfit: current.grossProfit,
    grossMarginPct: current.grossMarginPct,
    previous: {
      dateFrom: r.prevFrom,
      dateTo: r.prevTo,
      netSales: previous.netSalesRevenue,
      grossProfit: previous.grossProfit,
      grossMarginPct: previous.grossMarginPct,
    },
    netSalesChangePct: pctChange(current.netSalesRevenue, previous.netSalesRevenue),
    grossProfitChangePct: pctChange(current.grossProfit, previous.grossProfit),
    cashIn: now.cashIn,
    cashOut: now.cashOut,
    cashCollected: now.net,
    previousCashCollected: before.net,
  };
}
