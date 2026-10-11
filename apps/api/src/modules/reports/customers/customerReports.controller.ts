import type { Request, Response } from 'express';
import { buildCsv, sendCsv } from '../../../lib/csvBuilder.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './customerReports.service.js';

/** HTTP side of the customer reports (A3). */

export const schemas = { report: reportQuery };

const TOP_CUSTOMER_COLUMNS = [
  { key: 'customer_id', header: 'customer_id', type: 'integer' as const },
  { key: 'full_name', header: 'full_name', type: 'string' as const },
  { key: 'total_spend', header: 'total_spend', type: 'number' as const },
  { key: 'order_count', header: 'order_count', type: 'integer' as const },
];

export async function report(req: Request, res: Response): Promise<void> {
  res.json(await service.getCustomerReport(reportFilters(req)));
}

/** The top customers as CSV. */
export async function exportCsv(req: Request, res: Response): Promise<void> {
  const { topCustomers } = await service.getCustomerReport(reportFilters(req));
  const rows = topCustomers.map((c) => ({
    customer_id: c.customerId,
    full_name: c.fullName,
    total_spend: c.totalSpend,
    order_count: c.orderCount,
  }));
  const today = new Date().toISOString().slice(0, 10);
  sendCsv(res, `customers-report-${today}.csv`, buildCsv(rows, TOP_CUSTOMER_COLUMNS));
}
