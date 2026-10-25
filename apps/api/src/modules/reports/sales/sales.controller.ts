import type { Request, Response } from 'express';
import { buildCsv, sendCsv, SALES_COLUMNS } from '../../../lib/csvBuilder.js';
import * as service from './sales.service.js';
import { reportFilters, reportQuery } from '../reportScope.js';

/**
 * HTTP side of the sales reports (A3): validated query -> service -> response.
 * The branch is the session's; staff with access to all branches may pick one,
 * or none for all branches.
 */

export const schemas = { report: reportQuery };

export async function report(req: Request, res: Response): Promise<void> {
  res.json(await service.getSalesReport(reportFilters(req)));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await service.getSalesDetail(reportFilters(req)));
}

export async function grossProfitTrend(req: Request, res: Response): Promise<void> {
  res.json(await service.getGrossProfitTrend(reportFilters(req)));
}

/** The detail rows as CSV, with a totals row so the file foots on its own. */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const { rows, totals } = await service.getSalesDetail(reportFilters(req));
  const csvRows: Record<string, unknown>[] = rows.map((r) => ({
    date: r.date,
    invoice_no: r.invoiceNo,
    source: r.source,
    kind: r.kind,
    customer: r.customer,
    book: r.book,
    qty: r.qty,
    unit_price: r.unitPrice,
    discount: r.discount,
    gross_amount: r.grossAmount,
    return_amount: r.returnAmount,
    net_sales_amount: r.netSalesAmount,
    cost_amount: r.costAmount,
    gross_profit: r.grossProfit,
    payment_status: r.paymentStatus,
    cash_collected: r.cashCollected,
    receivable_balance: r.receivableBalance,
    branch: r.branch,
    location: r.location,
    user: r.user,
  }));
  csvRows.push({
    date: '', invoice_no: '', source: '', kind: '', customer: 'TOTAL', book: '',
    qty: totals.qty, unit_price: '', discount: '',
    gross_amount: totals.grossAmount, return_amount: totals.returnAmount,
    net_sales_amount: totals.netSalesAmount, cost_amount: totals.costAmount,
    gross_profit: totals.grossProfit, payment_status: '',
    cash_collected: totals.cashCollected, receivable_balance: totals.receivableBalance,
    branch: '', location: '', user: '',
  });
  const today = new Date().toISOString().slice(0, 10);
  sendCsv(res, `sales-report-${today}.csv`, buildCsv(csvRows, SALES_COLUMNS));
}
