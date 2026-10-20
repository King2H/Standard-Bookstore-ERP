import { Money, type SalesLine, type SalesTotals } from '@bms/shared';
import type { NetProfitParts, NetProfitResult, ReportFilters, SalesLineRecord, SalesSummary } from './sales.types.js';

/** Pure rules of the sales reports (A5): what counts as a sale, and the arithmetic over sales lines. */

/**
 * Order statuses that are not sales (owner decision 3a, #22): a draft is a
 * quote, nothing has left stock or been paid; a cancelled order is undone.
 * An order counts from confirmation, when its stock leaves and a cash order
 * is paid. Older rows may carry the pre-migration-33 names.
 */
export const NOT_SALE_ORDER_STATUSES = ['DRAFT', 'Pending', 'CANCELLED', 'Cancelled'] as const;

/** SQL list of NOT_SALE_ORDER_STATUSES, for `status NOT IN ${...}`. */
export const NOT_SALE_ORDER_STATUS_LIST = `(${NOT_SALE_ORDER_STATUSES.map((s) => `'${s}'`).join(', ')})`;

const ratioPct = (part: Money, whole: Money): number =>
  whole.isZero() ? 0 : Math.round((part.toNumber(4) / whole.toNumber(4)) * 10000) / 100;

/**
 * The accrual figures, summed over the same lines the Sales Report export
 * lists, so the cards and the export always agree for the same range.
 */
export function summarizeLines(rows: SalesLineRecord[]): SalesSummary {
  let grossSales = Money.ZERO;
  let discounts = Money.ZERO;
  const byType = { Normal: Money.ZERO, Merchant: Money.ZERO, Special: Money.ZERO };
  let returnsValue = Money.ZERO;
  let exchangeDifference = Money.ZERO;
  let costAmount = Money.ZERO;
  for (const row of rows) {
    if (row.transactionType === 'ORDER' || row.transactionType === 'POS') {
      grossSales = grossSales.plus(row.grossAmount);
      discounts = discounts.plus(row.discountAmount);
      const type = row.discountType ?? 'Normal';
      byType[type] = byType[type].plus(row.discountAmount);
    } else if (row.transactionType === 'RETURN') {
      returnsValue = returnsValue.minus(row.netAmount); // positive magnitude
    } else {
      exchangeDifference = exchangeDifference.plus(row.netAmount);
    }
    costAmount = costAmount.plus(row.costAmount);
  }
  const netSalesRevenue = grossSales.minus(discounts).minus(returnsValue).plus(exchangeDifference).round(2);
  const cost = costAmount.round(2);
  const grossProfit = netSalesRevenue.minus(cost);
  return {
    grossSales: grossSales.toNumber(),
    discounts: discounts.toNumber(),
    discountsByType: { Normal: byType.Normal.toNumber(), Merchant: byType.Merchant.toNumber(), Special: byType.Special.toNumber() },
    returnsValue: returnsValue.toNumber(),
    exchangeDifference: exchangeDifference.toNumber(),
    netSalesRevenue: netSalesRevenue.toNumber(),
    costAmount: cost.toNumber(),
    grossProfit: grossProfit.toNumber(),
    grossMarginPct: ratioPct(grossProfit, netSalesRevenue),
    rowCount: rows.length,
  };
}

/**
 * The Sales Report's lines and totals row. Cash collected and receivable
 * balance are invoice figures repeated on each line, so the totals count them
 * once per invoice.
 */
export function detailRows(records: SalesLineRecord[]): { rows: SalesLine[]; totals: SalesTotals } {
  const rows: SalesLine[] = records.map((r) => ({
    date: r.transactionDate,
    invoiceNo: r.referenceNumber,
    source: r.transactionType,
    customer: r.customerName,
    book: r.bookTitle,
    qty: r.quantity,
    unitPrice: r.unitPrice,
    discount: r.discountAmount,
    grossAmount: r.grossAmount,
    returnAmount: r.transactionType === 'RETURN' ? -r.netAmount : 0,
    netSalesAmount: r.netAmount,
    costAmount: r.costAmount,
    grossProfit: r.grossProfit,
    paymentStatus: r.paymentStatus,
    cashCollected: r.cashCollected,
    receivableBalance: r.receivableBalance,
    branch: r.branch,
    location: r.locationName,
    user: r.staffUsername,
  }));

  let qty = 0;
  let gross = Money.ZERO, returned = Money.ZERO, net = Money.ZERO, cost = Money.ZERO, profit = Money.ZERO;
  const invoices = new Map<string, { cash: number; receivable: number }>();
  for (const r of rows) {
    qty += r.qty;
    gross = gross.plus(r.grossAmount);
    returned = returned.plus(r.returnAmount);
    net = net.plus(r.netSalesAmount);
    cost = cost.plus(r.costAmount);
    profit = profit.plus(r.grossProfit);
    const key = `${r.source}:${r.invoiceNo}`;
    if (!invoices.has(key)) invoices.set(key, { cash: r.cashCollected, receivable: r.receivableBalance });
  }
  const invoiceTotals = [...invoices.values()];
  return {
    rows,
    totals: {
      qty,
      grossAmount: gross.toNumber(),
      returnAmount: returned.toNumber(),
      netSalesAmount: net.toNumber(),
      costAmount: cost.toNumber(),
      grossProfit: profit.toNumber(),
      grossMarginPct: ratioPct(profit, net),
      cashCollected: Money.sum(invoiceTotals.map((v) => v.cash)).toNumber(),
      receivableBalance: Money.sum(invoiceTotals.map((v) => v.receivable)).toNumber(),
    },
  };
}

/**
 * The first day of the bucket a day (YYYY-MM-DD) falls in: the day itself,
 * the Monday of its week, or the first of its month, as date_trunc does for
 * the other report series.
 */
export function periodStart(day: string, groupBy: ReportFilters['groupBy']): string {
  if (groupBy === 'month') return `${day.slice(0, 7)}-01`;
  if (groupBy === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return day;
}

/** Net sales and gross profit per day, week or month (was: always per day), over the same lines. */
export function grossProfitTrend(
  rows: SalesLineRecord[],
  groupBy: ReportFilters['groupBy'],
): Array<{ period: string; netSales: number; grossProfit: number; grossMarginPct: number }> {
  const byPeriod = new Map<string, { net: Money; cost: Money }>();
  for (const r of rows) {
    const period = periodStart(r.transactionDate, groupBy);
    const sum = byPeriod.get(period) ?? { net: Money.ZERO, cost: Money.ZERO };
    byPeriod.set(period, { net: sum.net.plus(r.netAmount), cost: sum.cost.plus(r.costAmount) });
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => {
      const netSales = v.net.round(2);
      const grossProfit = netSales.minus(v.cost.round(2));
      return { period, netSales: netSales.toNumber(), grossProfit: grossProfit.toNumber(), grossMarginPct: ratioPct(grossProfit, netSales) };
    });
}

/**
 * Collected-cash profit: cash orders, collected credit and cash POS, less
 * the cost of what was sold, less returns at their refund with their
 * original cost credited back, plus exchange cash. Revenue is already net of
 * discounts, so the discounts are reported, not subtracted again.
 */
export function netProfit(p: NetProfitParts): NetProfitResult {
  const cashSalesRevenue = Money.of(p.cashSalesRevenue);
  const collectedCreditRevenue = Money.of(p.collectedCreditRevenue);
  const fulfilledRevenue = cashSalesRevenue.plus(collectedCreditRevenue).plus(p.posRevenue);
  const purchaseCost = Money.of(p.orderCost).plus(p.posCost);
  const profit = fulfilledRevenue.minus(purchaseCost).minus(p.returnsValue).plus(p.returnsCost).plus(p.exchangeAdjustment);
  return {
    netProfit: profit.toNumber(),
    fulfilledRevenue: fulfilledRevenue.toNumber(),
    purchaseCost: purchaseCost.toNumber(),
    totalDiscounts: Money.of(p.orderDiscounts).plus(p.posDiscounts).toNumber(),
    returnsValue: Money.of(p.returnsValue).toNumber(),
    returnsCost: Money.of(p.returnsCost).toNumber(),
    exchangeAdjustment: Money.of(p.exchangeAdjustment).toNumber(),
    cashSalesRevenue: cashSalesRevenue.toNumber(),
    creditSalesRevenue: collectedCreditRevenue.toNumber(),
    collectedCreditRevenue: collectedCreditRevenue.toNumber(),
    outstandingReceivables: Money.of(p.outstandingReceivables).toNumber(),
  };
}

/** Percent change against the previous period; null when that was 0. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100;
}
