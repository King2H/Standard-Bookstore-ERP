import { Money, type KpiPeriod, type KpiReport, type PeriodKpis } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import { netProfit, salesSummary } from '../sales/sales.service.js';
import { pctChange } from '../sales/sales.policy.js';
import * as kpis from './kpis.repository.js';
import * as policy from './kpis.policy.js';

/** Dashboard KPI use cases (#22), read on the report connection. */

export async function getKpis(branchId: number | undefined): Promise<KpiReport> {
  const cal = await kpis.calendar(reportDb);
  const today = { branchId, dateFrom: cal.today, dateTo: cal.today };
  const month = { branchId, dateFrom: cal.month_start, dateTo: cal.today };
  const [f, dailyProfit, monthlyProfit, daily, monthly] = await Promise.all([
    kpis.kpiFigures(reportDb, branchId),
    netProfit(today),
    netProfit(month),
    salesSummary(today),
    salesSummary(month),
  ]);
  return {
    dailySales: policy.total(f.dailyOrderSales, f.dailyPosSales, f.dailyExchangeSales),
    monthlySales: policy.total(f.monthlyOrderSales, f.monthlyPosSales, f.monthlyExchangeSales),
    dailyRevenue: policy.total(f.dailyPosCollected, f.dailyOrderCollected, f.dailyExchangeCollected),
    monthlyRevenue: policy.total(f.monthlyPosCollected, f.monthlyOrderCollected, f.monthlyExchangeCollected),
    averageOrderValue: policy.total(f.averageOrderValue),
    totalActiveCustomers: f.activeCustomers,
    lowStockAlerts: f.lowStockAlerts,
    pendingOrders: f.pendingOrders,
    totalExchangesToday: f.exchangesToday,
    outstandingBalance: policy.total(f.outstanding),
    // Collected-cash view for the month (Cash & Receivables cards).
    netProfit: monthlyProfit.netProfit,
    fulfilledRevenue: monthlyProfit.fulfilledRevenue,
    outstandingReceivables: monthlyProfit.outstandingReceivables,
    cashSalesRevenue: monthlyProfit.cashSalesRevenue,
    creditSalesRevenue: monthlyProfit.creditSalesRevenue,
    collectedCreditRevenue: monthlyProfit.collectedCreditRevenue,
    purchaseCost: monthlyProfit.purchaseCost,
    totalDiscounts: monthlyProfit.totalDiscounts,
    grossProfit: Money.of(monthlyProfit.fulfilledRevenue).minus(monthlyProfit.purchaseCost).toNumber(),
    dailyNetProfit: dailyProfit.netProfit,
    monthlyNetProfit: monthlyProfit.netProfit,
    // Accrual view over the sales lines: the dashboard's one "Net Profit" figure.
    dailyNetSalesRevenue: daily.netSalesRevenue,
    monthlyNetSalesRevenue: monthly.netSalesRevenue,
    dailyNetProfitUnified: daily.grossProfit,
    monthlyNetProfitUnified: monthly.grossProfit,
    dailyGrossMarginPct: daily.grossMarginPct,
    monthlyGrossMarginPct: monthly.grossMarginPct,
    grossProfitUnified: monthly.grossProfit,
    overdueReceivablesAmount: policy.total(f.overdue),
    inventoryValue: policy.total(f.inventoryValue),
  };
}

/** Sales Performance for a period so far, against the previous equivalent period. */
export async function getPeriodKpis(branchId: number | undefined, period: KpiPeriod): Promise<PeriodKpis> {
  const r = policy.periodRange(period, await kpis.calendar(reportDb));
  const [current, previous, cash, prevCash] = await Promise.all([
    salesSummary({ branchId, dateFrom: r.dateFrom, dateTo: r.dateTo }),
    salesSummary({ branchId, dateFrom: r.prevFrom, dateTo: r.prevTo }),
    kpis.cashCollected(reportDb, branchId, r.dateFrom, r.dateTo),
    kpis.cashCollected(reportDb, branchId, r.prevFrom, r.prevTo),
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
    cashCollected: policy.total(...cash),
    previousCashCollected: policy.total(...prevCash),
  };
}
