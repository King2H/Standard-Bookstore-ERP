import type { Request, Response } from 'express';
import { TopReportQuerySchema } from '@bms/shared';
import { buildCsv, sendCsv, RETURN_COLUMNS } from '../../../lib/csvBuilder.js';
import { valid } from '../../../middleware/validate.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './returnReports.service.js';

/** HTTP side of the return reports (A3). */

export const schemas = { report: reportQuery, top: { query: TopReportQuerySchema } };

export async function report(req: Request, res: Response): Promise<void> {
  res.json({ rows: await service.getReturnRows(reportFilters(req)) });
}

export async function top(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.top);
  res.json(await service.getTopReturned(reportFilters(req), query.limit));
}

export async function exportCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getReturnRows(reportFilters(req))).map((r) => ({
    return_no: r.returnNo,
    original_invoice_no: r.originalInvoiceNo,
    customer: r.customer,
    book: r.book,
    qty_returned: r.qtyReturned,
    refund_amount: r.refundAmount,
    original_cost: r.originalCost,
    profit_reversed: r.profitReversed,
    refund_method: r.refundMethod,
    return_date: r.returnDate,
    user: r.user,
  }));
  const today = new Date().toISOString().slice(0, 10);
  sendCsv(res, `returns-report-${today}.csv`, buildCsv(rows, RETURN_COLUMNS));
}
