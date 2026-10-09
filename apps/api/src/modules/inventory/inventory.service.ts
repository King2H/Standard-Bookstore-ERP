import type { PoolClient } from 'pg';
import type { ReorderPointRequest, StockInRequest, StockOutRequest, TransferStockRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertOutbox } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as movements from './inventoryTransaction.service.js';
import * as policy from './inventory.policy.js';
import * as stock from './inventory.repository.js';
import type {
  Actor,
  Adjustment,
  LocationStockRecord,
  LockedLevel,
  Paged,
  Paging,
  StockLevelFilter,
  StockLevelRecord,
  StockMovementFilter,
  StockMovementRecord,
} from './inventory.types.js';

/**
 * Use cases of the Inventory module (A4): one function each, owning its
 * transaction. Stock in, stock out and transfers still run through
 * inventoryTransaction.service on the same connection until part 2 (#21).
 */

function window(paging: Paging) {
  return { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize };
}

function paged<T>(result: { items: T[]; total: number }, paging: Paging): Paged<T> {
  return { ...result, page: paging.page, totalPages: Math.ceil(result.total / paging.pageSize) };
}

function audit(q: Queryable, actor: Actor, entityType: string, level: { bookId: number; locationId: number }, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action: 'UPDATE',
    entityType,
    entityId: `${level.bookId}:${level.locationId}`,
    meta,
  });
}

async function lockOrThrow(q: Queryable, bookId: number, locationId: number): Promise<LockedLevel> {
  const level = await stock.lockLevel(q, bookId, locationId);
  if (!level) throw new NotFoundError('Inventory record');
  return level;
}

async function levelOrThrow(q: Queryable, bookId: number, locationId: number): Promise<StockLevelRecord> {
  const level = await stock.findLevel(q, bookId, locationId);
  if (!level) throw new NotFoundError('Inventory record');
  return level;
}

/**
 * Notifications for a change, written in its transaction so they are sent
 * exactly when the change commits: the movement itself, and a low-stock or
 * out-of-stock alert when the quantity crosses that threshold.
 */
async function notify(
  client: PoolClient,
  event: 'inventory.stock_in' | 'inventory.stock_out' | 'inventory.adjustment',
  level: StockLevelRecord,
  quantityBefore: number,
  details: Record<string, unknown>,
): Promise<void> {
  const where = {
    bookId: level.bookId,
    bookTitle: level.bookTitle,
    locationId: level.locationId,
    locationName: level.locationName,
    branchId: level.branchId,
  };
  await insertOutbox(client, event, { ...where, ...details });
  await notifyThreshold(client, level, quantityBefore);
}

async function notifyThreshold(client: PoolClient, level: StockLevelRecord, quantityBefore: number): Promise<void> {
  const alert = policy.stockAlert(quantityBefore, level.quantity, level.reorderPoint);
  if (!alert) return;
  await insertOutbox(client, alert, {
    bookId: level.bookId,
    bookTitle: level.bookTitle,
    locationId: level.locationId,
    locationName: level.locationName,
    branchId: level.branchId,
    quantity: level.quantity,
    ...(alert === 'inventory.low_stock' && { reorderPoint: level.reorderPoint }),
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listStock(filter: StockLevelFilter, paging: Paging): Promise<Paged<StockLevelRecord>> {
  return paged(await stock.listLevels(kysely, filter, window(paging)), paging);
}

export async function listLowStock(branchId: number, paging: Paging): Promise<Paged<StockLevelRecord>> {
  return paged(await stock.lowStock(kysely, branchId, window(paging)), paging);
}

export async function listMovements(filter: StockMovementFilter, paging: Paging): Promise<Paged<StockMovementRecord>> {
  return paged(await stock.movements(kysely, filter, window(paging)), paging);
}

export function bookStock(bookId: number, branchId: number | undefined): Promise<LocationStockRecord[]> {
  return stock.stockByLocation(kysely, bookId, branchId);
}

// ── Changes ───────────────────────────────────────────────────────────────────

/** A manual correction: damage, loss, a return to the shelf, or a count discrepancy. */
export async function adjustStock(actor: Actor, adjustment: Adjustment): Promise<StockLevelRecord> {
  const { bookId, locationId, delta, reasonCode } = adjustment;
  policy.checkAdjustmentDirection(reasonCode, delta);

  return withTransaction({}, async (tx, client) => {
    const before = await lockOrThrow(tx, bookId, locationId);
    policy.checkVersion(before.version, adjustment.version);
    const after = policy.quantityAfterAdjustment(before.quantity, delta);

    await stock.setQuantity(tx, bookId, locationId, after);
    await stock.insertAdjustment(tx, {
      bookId,
      locationId,
      qtyBefore: before.quantity,
      qtyAfter: after,
      delta,
      reasonCode,
      referenceType: adjustment.referenceType ?? null,
      referenceId: adjustment.referenceId ?? null,
      notes: adjustment.notes ?? null,
      staffId: actor.staffId,
    });
    await audit(tx, actor, 'inventory', adjustment, {
      bookId,
      locationId,
      delta,
      reasonCode,
      qtyBefore: before.quantity,
      qtyAfter: after,
    });

    const level = await levelOrThrow(tx, bookId, locationId);
    await notify(client, 'inventory.adjustment', level, before.quantity, {
      delta,
      reasonCode,
      notes: adjustment.notes ?? null,
    });
    return level;
  });
}

/** Moves stock between two locations of one branch. */
export async function transferStock(
  actor: Actor,
  transfer: TransferStockRequest,
): Promise<{ from: StockLevelRecord; to: StockLevelRecord }> {
  // One consistent snapshot of both rows.
  return withTransaction({ isolationLevel: 'repeatable read' }, async (tx, client) => {
    await movements.transfer({ ...transfer, staffCtx: actor }, client);

    const from = await levelOrThrow(tx, transfer.bookId, transfer.fromLocationId);
    const to = await levelOrThrow(tx, transfer.bookId, transfer.toLocationId);
    await insertOutbox(client, 'inventory.transfer_completed', {
      bookId: from.bookId,
      bookTitle: from.bookTitle,
      fromLocationId: from.locationId,
      fromLocationName: from.locationName,
      toLocationId: to.locationId,
      toLocationName: to.locationName,
      branchId: from.branchId,
      quantity: transfer.quantity,
    });
    await notifyThreshold(client, from, from.quantity + transfer.quantity);
    return { from, to };
  });
}

/** Stock received by hand (procurement receiving books it through its own flow). */
export async function stockIn(actor: Actor, receipt: StockInRequest): Promise<StockLevelRecord> {
  const { bookId, locationId, quantity } = receipt;
  const referenceType = receipt.referenceType ?? 'manual';

  return withTransaction({}, async (tx, client) => {
    await stock.ensureLevel(tx, bookId, locationId);
    const before = await lockOrThrow(tx, bookId, locationId);
    policy.checkVersion(before.version, receipt.version);

    await movements.stockIn(
      { bookId, locationId, quantity, staffCtx: actor, referenceType, referenceId: receipt.referenceId, notes: receipt.notes },
      client,
    );
    await audit(tx, actor, 'inventory_stock_in', receipt, {
      bookId,
      locationId,
      quantity,
      referenceType,
      referenceId: receipt.referenceId,
      qtyBefore: before.quantity,
      qtyAfter: before.quantity + quantity,
    });

    const level = await levelOrThrow(tx, bookId, locationId);
    await notify(client, 'inventory.stock_in', level, before.quantity, { quantity });
    return level;
  });
}

/** Stock issued by hand; sales take stock out through POS and orders. */
export async function stockOut(actor: Actor, issue: StockOutRequest): Promise<StockLevelRecord> {
  const { bookId, locationId, quantity, referenceType } = issue;

  return withTransaction({}, async (tx, client) => {
    const before = await lockOrThrow(tx, bookId, locationId);
    policy.checkVersion(before.version, issue.version);

    await movements.stockOut(
      { bookId, locationId, quantity, staffCtx: actor, referenceType, referenceId: issue.referenceId, notes: issue.notes },
      client,
    );
    const level = await levelOrThrow(tx, bookId, locationId);
    await audit(tx, actor, 'inventory_stock_out', issue, {
      bookId,
      locationId,
      quantity,
      referenceType,
      referenceId: issue.referenceId,
      qtyBefore: before.quantity,
      qtyAfter: level.quantity,
    });

    await notify(client, 'inventory.stock_out', level, before.quantity, {
      quantity,
      reasonCode: referenceType ?? 'manual',
    });
    return level;
  });
}

export async function setReorderPoint(actor: Actor, change: ReorderPointRequest): Promise<StockLevelRecord> {
  const { bookId, locationId, reorderPoint } = change;
  return withTransaction({}, async (tx) => {
    if (!(await stock.setReorderPoint(tx, bookId, locationId, reorderPoint))) throw new NotFoundError('Inventory record');
    await audit(tx, actor, 'inventory_reorder', change, { bookId, locationId, reorderPoint });
    return levelOrThrow(tx, bookId, locationId);
  });
}
