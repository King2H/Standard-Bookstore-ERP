import type { Request, Response } from 'express';
import { buildCsv, sendCsv, EXCHANGE_DETAIL_COLUMNS } from '../../../lib/csvBuilder.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './exchangeReports.service.js';

/** HTTP side of the exchange reports (A3). */

export const schemas = { report: reportQuery };

export async function report(req: Request, res: Response): Promise<void> {
  res.json(await service.getExchangeReport(reportFilters(req)));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json({ rows: await service.getExchangeDetail(reportFilters(req)) });
}

/** One row per exchange, as CSV. */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getExchangeDetail(reportFilters(req))).map((r) => ({
    exchange_no: r.exchangeNo,
    customer: r.customer,
    incoming_book: r.incomingBook,
    incoming_value: r.incomingValue,
    outgoing_book: r.outgoingBook,
    outgoing_value: r.outgoingValue,
    difference: r.difference,
    difference_payment_status: r.differencePaymentStatus,
    cash_collected: r.cashCollected,
    receivable_balance: r.receivableBalance,
    date: r.date,
    user: r.user,
  }));
  const today = new Date().toISOString().slice(0, 10);
  sendCsv(res, `exchanges-report-${today}.csv`, buildCsv(rows, EXCHANGE_DETAIL_COLUMNS));
}
