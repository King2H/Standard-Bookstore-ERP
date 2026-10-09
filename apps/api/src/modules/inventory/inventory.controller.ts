import type { Request, Response } from 'express';
import {
  AdjustStockRequestSchema,
  BookStockParamsSchema,
  BookStockQuerySchema,
  BranchPagingQuerySchema,
  ReorderPointRequestSchema,
  StockInRequestSchema,
  StockLevelListQuerySchema,
  StockMovementListQuerySchema,
  StockOutRequestSchema,
  TransferStockRequestSchema,
  type BookStockResponse,
  type StockLevel,
  type StockLevelListResponse,
  type StockMovementListResponse,
  type TransferStockResponse,
} from '@bms/shared';
import { AppError } from '../../lib/errors.js';
import { assertLocationInBranch, assertLocationUsable, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toLocationStockResponse, toStockLevelResponse, toStockMovementResponse } from './inventory.mapper.js';
import * as policy from './inventory.policy.js';
import * as service from './inventory.service.js';
import type { Actor } from './inventory.types.js';

/**
 * HTTP side of the Inventory module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: StockLevelListQuerySchema },
  lowStock: { query: BranchPagingQuerySchema },
  history: { query: StockMovementListQuerySchema },
  adjust: { body: AdjustStockRequestSchema },
  transfer: { body: TransferStockRequestSchema },
  reorderPoint: { body: ReorderPointRequestSchema },
  stockIn: { body: StockInRequestSchema },
  stockOut: { body: StockOutRequestSchema },
  bookStock: { params: BookStockParamsSchema, query: BookStockQuerySchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listStock(
    {
      branchId: scopedBranch(req),
      locationId: query.locationId,
      bookId: query.bookId,
      lowStockOnly: query.lowStockOnly,
      q: query.q,
      isActive: policy.isActiveFilter(query.is_active),
      statuses: query.status === undefined ? undefined : policy.statusesFor(query.status),
      sortBy: query.sortBy,
      sortDir: query.sortDir,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: StockLevelListResponse = { ...result, items: result.items.map(toStockLevelResponse) };
  res.json(body);
}

export async function lowStock(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.lowStock);
  const result = await service.listLowStock(scopedBranch(req), { page: query.page, pageSize: query.pageSize });
  const body: StockLevelListResponse = { ...result, items: result.items.map(toStockLevelResponse) };
  res.json(body);
}

export async function history(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.history);
  const result = await service.listMovements(
    {
      branchId: scopedBranch(req),
      bookId: query.bookId,
      locationId: query.locationId,
      reasonCode: query.reasonCode,
      movementType: query.movementType,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: StockMovementListResponse = { ...result, items: result.items.map(toStockMovementResponse) };
  res.json(body);
}

// Stock is booked in the session's branch, and staff with assigned locations
// move it only there (#72); a transfer may send it to any location of the branch.

export async function adjust(req: Request, res: Response): Promise<void> {
  const { body: adjustment } = valid(req, schemas.adjust);
  await assertLocationUsable(req, adjustment.locationId);
  const body: StockLevel = toStockLevelResponse(await service.adjustStock(actor(req), adjustment));
  res.json(body);
}

export async function transfer(req: Request, res: Response): Promise<void> {
  const { body: transfer } = valid(req, schemas.transfer);
  await assertLocationUsable(req, transfer.fromLocationId);
  await assertLocationInBranch(req, transfer.toLocationId);
  const result = await service.transferStock(actor(req), transfer);
  const body: TransferStockResponse = { from: toStockLevelResponse(result.from), to: toStockLevelResponse(result.to) };
  res.json(body);
}

export async function reorderPoint(req: Request, res: Response): Promise<void> {
  const { body: change } = valid(req, schemas.reorderPoint);
  await assertLocationInBranch(req, change.locationId);
  const body: StockLevel = toStockLevelResponse(await service.setReorderPoint(actor(req), change));
  res.json(body);
}

export async function stockIn(req: Request, res: Response): Promise<void> {
  const { body: receipt } = valid(req, schemas.stockIn);
  await assertLocationUsable(req, receipt.locationId);
  const body: StockLevel = toStockLevelResponse(await service.stockIn(actor(req), receipt));
  res.json(body);
}

export async function stockOut(req: Request, res: Response): Promise<void> {
  const { body: issue } = valid(req, schemas.stockOut);
  await assertLocationUsable(req, issue.locationId);
  const body: StockLevel = toStockLevelResponse(await service.stockOut(actor(req), issue));
  res.json(body);
}

export async function bookStock(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.bookStock);
  // Not branch-scoped (#12): staff may see where a book is in stock, in any branch.
  const items = await service.bookStock(params.bookId, query.branchId ?? req.staff!.branchId);
  const body: BookStockResponse = { items: items.map(toLocationStockResponse) };
  res.json(body);
}

/**
 * Retired (#21, owner decision): stock in and transfers create the stock row
 * for a book at a location when it first gets stock.
 */
export function initialize(): never {
  throw new AppError(
    'DEPRECATED',
    'POST /inventory/initialize is no longer supported. Stock in and transfers create the stock record when needed.',
    410,
  );
}
