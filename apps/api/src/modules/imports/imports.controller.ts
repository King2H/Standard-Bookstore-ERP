import type { Request, Response } from 'express';
import { ImportRequestSchema, type ImportReport, type ImportResult } from '@bms/shared';
import { sendCsv } from '../../lib/csvBuilder.js';
import { scopedBranch } from '../../lib/scope.js';
import { holdsPermission } from '../../middleware/rbac.js';
import { valid } from '../../middleware/validate.js';
import type { Actor } from '../catalog/catalog.types.js';
import { usableLocationIds } from '../location/location.service.js';
import * as balances from './balanceImport.service.js';
import * as customers from './customerImport.service.js';
import * as service from './imports.service.js';
import * as stock from './stockImport.service.js';

/** HTTP side of bulk import and export (#246): validated request -> service -> response. */

export const schemas = {
  file: { body: ImportRequestSchema },
};

function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

const today = () => new Date().toISOString().slice(0, 10);

export function catalogTemplate(_req: Request, res: Response): void {
  sendCsv(res, 'catalog-template.csv', service.catalogTemplate());
}

export async function checkCatalog(req: Request, res: Response): Promise<void> {
  const body: ImportReport = await service.checkCatalog(valid(req, schemas.file).body);
  res.json(body);
}

export async function importCatalog(req: Request, res: Response): Promise<void> {
  const body: ImportResult = await service.importCatalog(actor(req), valid(req, schemas.file).body);
  res.json(body);
}

export async function exportCatalog(_req: Request, res: Response): Promise<void> {
  sendCsv(res, `catalog-${today()}.csv`, await service.exportCatalog());
}

// ── Opening stock: the session's branch, and the locations the caller may use ──

async function stockScope(req: Request): Promise<stock.StockScope> {
  return { branchId: scopedBranch(req), usable: await usableLocationIds(req.staff!) };
}

export function stockTemplate(_req: Request, res: Response): void {
  sendCsv(res, 'opening-stock-template.csv', stock.stockTemplate());
}

export async function checkStock(req: Request, res: Response): Promise<void> {
  const body: ImportReport = await stock.checkStock(valid(req, schemas.file).body, await stockScope(req));
  res.json(body);
}

export async function importStock(req: Request, res: Response): Promise<void> {
  const body: ImportResult = await stock.importStock(actor(req), valid(req, schemas.file).body, await stockScope(req));
  res.json(body);
}

/** The cost column only for who may see costs (VIEW_COST, #234). */
export async function exportStock(req: Request, res: Response): Promise<void> {
  sendCsv(res, `opening-stock-${today()}.csv`, await stock.exportStock(scopedBranch(req), holdsPermission(req, 'VIEW_COST')));
}

// ── Customers ──────────────────────────────────────────────────────────────

export function customerTemplate(_req: Request, res: Response): void {
  sendCsv(res, 'customers-template.csv', customers.customerTemplate());
}

export async function checkCustomers(req: Request, res: Response): Promise<void> {
  const body: ImportReport = await customers.checkCustomers(valid(req, schemas.file).body);
  res.json(body);
}

export async function importCustomers(req: Request, res: Response): Promise<void> {
  const body: ImportResult = await customers.importCustomers(actor(req), valid(req, schemas.file).body);
  res.json(body);
}

export async function exportCustomers(req: Request, res: Response): Promise<void> {
  sendCsv(res, `customers-${today()}.csv`, await customers.exportCustomers(actor(req)));
}

// ── Opening balances (#246 part 3) ─────────────────────────────────────────

export function customerBalanceTemplate(_req: Request, res: Response): void {
  sendCsv(res, 'customer-balances-template.csv', balances.customerBalanceTemplate());
}

export async function checkCustomerBalances(req: Request, res: Response): Promise<void> {
  const body: ImportReport = await balances.checkCustomerBalances(valid(req, schemas.file).body);
  res.json(body);
}

export async function importCustomerBalances(req: Request, res: Response): Promise<void> {
  const body: ImportResult = await balances.importCustomerBalances(actor(req), valid(req, schemas.file).body);
  res.json(body);
}

export function supplierBalanceTemplate(_req: Request, res: Response): void {
  sendCsv(res, 'supplier-balances-template.csv', balances.supplierBalanceTemplate());
}

export async function checkSupplierBalances(req: Request, res: Response): Promise<void> {
  const body: ImportReport = await balances.checkSupplierBalances(valid(req, schemas.file).body);
  res.json(body);
}

export async function importSupplierBalances(req: Request, res: Response): Promise<void> {
  const body: ImportResult = await balances.importSupplierBalances(actor(req), valid(req, schemas.file).body);
  res.json(body);
}
