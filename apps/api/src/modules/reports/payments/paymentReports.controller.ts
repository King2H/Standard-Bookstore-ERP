import type { Request, Response } from 'express';
import { buildCsv, sendCsv, PAYMENTS_LEDGER_COLUMNS } from '../../../lib/csvBuilder.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './paymentReports.service.js';

/** HTTP side of the payment reports (A3). */

export const schemas = { report: reportQuery };

const today = () => new Date().toISOString().slice(0, 10);

const SUMMARY_COLUMNS = [
  { key: 'metric', header: 'metric', type: 'string' as const },
  { key: 'amount', header: 'amount', type: 'number' as const },
];

export async function report(req: Request, res: Response): Promise<void> {
  res.json(await service.getPaymentReport(reportFilters(req)));
}

/** The totals and money in by method, as CSV. */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const { summary, byMethod } = await service.getPaymentReport(reportFilters(req));
  const rows: Record<string, unknown>[] = [
    { metric: 'Total Collected', amount: summary.totalCollected },
    { metric: 'Total Refunded', amount: summary.totalRefunded },
    { metric: 'Net Collected', amount: summary.netCollected },
    { metric: 'Pending Payments', amount: summary.pendingPayments },
    ...byMethod.map((m) => ({ metric: `Method: ${m.method}`, amount: m.total })),
  ];
  sendCsv(res, `payments-report-${today()}.csv`, buildCsv(rows, SUMMARY_COLUMNS));
}

export async function ledger(req: Request, res: Response): Promise<void> {
  res.json({ rows: await service.getPaymentsLedger(reportFilters(req)) });
}

export async function ledgerCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getPaymentsLedger(reportFilters(req))).map((r) => ({
    receipt_no: r.receiptNo,
    party: r.party,
    reference_type: r.referenceType,
    reference_no: r.referenceNo,
    payment_method: r.paymentMethod,
    payer_bank: r.payerBank,
    payment_reference: r.paymentReference,
    amount: r.amount,
    direction: r.direction,
    date: r.date,
    user: r.user,
  }));
  sendCsv(res, `payments-ledger-${today()}.csv`, buildCsv(rows, PAYMENTS_LEDGER_COLUMNS));
}
