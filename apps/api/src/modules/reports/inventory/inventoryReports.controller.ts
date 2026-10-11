import type { Request, Response } from 'express';
import { buildCsv, sendCsv, INVENTORY_COLUMNS, INVENTORY_VALUATION_COLUMNS } from '../../../lib/csvBuilder.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './inventoryReports.service.js';

/** HTTP side of the stock reports (A3). */

export const schemas = { report: reportQuery };

const today = () => new Date().toISOString().slice(0, 10);

export async function report(req: Request, res: Response): Promise<void> {
  res.json(await service.getInventoryReport(reportFilters(req)));
}

export async function exportCsv(req: Request, res: Response): Promise<void> {
  const rows = await service.getStockExportRows(reportFilters(req).branchId);
  sendCsv(res, `inventory-export-${today()}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], INVENTORY_COLUMNS));
}

export async function valuationCsv(req: Request, res: Response): Promise<void> {
  const rows = await service.getStockExportRows(reportFilters(req).branchId);
  sendCsv(res, `inventory-valuation-${today()}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], INVENTORY_VALUATION_COLUMNS));
}
