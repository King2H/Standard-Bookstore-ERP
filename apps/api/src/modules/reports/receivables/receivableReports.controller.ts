import type { Request, Response } from 'express';
import { buildCsv, sendCsv, RECEIVABLES_AGING_COLUMNS, RECEIVABLES_COLUMNS } from '../../../lib/csvBuilder.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './receivableReports.service.js';

/** HTTP side of the receivables reports (A3). */

export const schemas = { report: reportQuery };

const today = () => new Date().toISOString().slice(0, 10);

export async function aging(req: Request, res: Response): Promise<void> {
  res.json(await service.getAging(reportFilters(req).branchId));
}

export async function agingCsv(req: Request, res: Response): Promise<void> {
  const { rows } = await service.getAging(reportFilters(req).branchId);
  const csvRows = rows.map((r) => ({
    customer: r.customer,
    invoice_no: r.invoiceNo,
    invoice_date: r.invoiceDate,
    due_date: r.dueDate,
    outstanding_amount: r.outstandingAmount,
    aging_bucket: r.agingBucket,
    last_payment_date: r.lastPaymentDate,
  }));
  sendCsv(res, `receivables-aging-${today()}.csv`, buildCsv(csvRows, RECEIVABLES_AGING_COLUMNS));
}

export async function exportCsv(req: Request, res: Response): Promise<void> {
  const rows = await service.getReceivableExportRows(reportFilters(req));
  sendCsv(res, `receivables-report-${today()}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], RECEIVABLES_COLUMNS));
}
