import { Money, type ReorderPointRequest, type StockInRequest, type StockOutRequest, type TransferStockRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { isNegativeStockAllowed } from '../config/config.service.js';
import { branchesOf } from '../location/location.repository.js';
import * as policy from './inventory.policy.js';
import * as stock from './inventory.repository.js';
import type {
  Actor,
  Adjustment,
  LocationStockRecord,
  LockedLevel,
  Paged,
  Paging,
  StockChange,
  StockLevelFilter,
  StockLevelRecord,
  StockMovementFilter,
  StockMovementRecord,
  StockReceipt,
} from './inventory.types.js';

/**
 * Use cases of the Inventory module (A4). Every change to a stock quantity
 * goes through the stock movements below: they run inside the caller's
 * transaction (orders, POS, procurement, returns and exchanges book theirs
 * with their own documents) and write the history row and any stock alert
 * with it. The endpoint use cases further down open their own transaction.
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

function where(level: StockLevelRecord) {
  return {
    bookId: level.bookId,
    bookTitle: level.bookTitle,
    locationId: level.locationId,
    locationName: level.locationName,
    branchId: level.branchId,
  };
}

/** A low-stock or out-of-stock alert when the change crossed that threshold (owner decision, #21). */
async function alertOnThreshold(q: Queryable, bookId: number, locationId: number, quantityBefore: number): Promise<void> {
  const level = await levelOrThrow(q, bookId, locationId);
  const alert = policy.stockAlert(quantityBefore, level.quantity, level.reorderPoint);
  if (!alert) return;
  await insertOutboxEvent(q, alert, {
    ...where(level),
    quantity: level.quantity,
    ...(alert === 'inventory.low_stock' && { reorderPoint: level.reorderPoint }),
  });
}

function checkQuantity(quantity: number): void {
  if (!(quantity > 0)) throw new ValidationError('Quantity must be positive', { field: 'quantity' });
}

// ── Stock movements, inside the caller's transaction ─────────────────────────

/** What a location holds of a book. Reservations are already deducted from `quantity`. */
export async function availableStock(
  q: Queryable,
  bookId: number,
  locationId: number,
): Promise<{ quantity: number; reserved: number; available: number }> {
  const level = await stock.findLevel(q, bookId, locationId);
  if (!level) return { quantity: 0, reserved: 0, available: 0 };
  return { quantity: level.quantity, reserved: level.reserved, available: Math.max(0, level.quantity) };
}

/** Stock of several books at one location, for the sale and exchange screens. */
export async function bookAvailability(
  q: Queryable,
  bookIds: number[],
  locationId: number,
): Promise<{ bookId: number; locationId: number; locationName: string; onHand: number; reserved: number; available: number }[]> {
  const rows = await stock.availability(q, bookIds, locationId);
  return rows.map((r) => ({
    bookId: r.bookId,
    locationId: r.locationId,
    locationName: r.locationName,
    onHand: r.quantity,
    reserved: r.reserved,
    available: Math.max(0, r.quantity),
  }));
}

/**
 * Stock arriving at a location: a purchase, a return, a cancelled order. The
 * location's stock record is created when it has none yet.
 */
export async function receiveStock(tx: Queryable, receipt: StockReceipt): Promise<{ averageCost: Money }> {
  const { bookId, locationId, quantity } = receipt;
  checkQuantity(quantity);
  const unitCost = receipt.unitCost === undefined ? undefined : Money.of(receipt.unitCost);
  if (unitCost && (unitCost.isNegative() || (unitCost.isZero() && !receipt.freeOfCharge))) {
    throw new ValidationError('A unit cost must be more than zero; stock without a value would distort the average cost', {
      field: 'unitCost',
    });
  }

  await stock.ensureLevel(tx, bookId, locationId);
  const before = await lockOrThrow(tx, bookId, locationId);
  const after = before.quantity + quantity;
  const averageCost = unitCost
    ? policy.averageCostAfterReceipt(before.quantity, before.averageCost, quantity, unitCost)
    : before.averageCost;
  await stock.updateLevel(tx, bookId, locationId, { quantity: after, averageCost });
  await stock.insertMovement(tx, {
    bookId,
    locationId,
    qtyBefore: before.quantity,
    qtyAfter: after,
    movementType: 'stock_in',
    reasonCode: receipt.reasonCode ?? 'return',
    referenceType: receipt.referenceType ?? null,
    referenceId: receipt.referenceId ?? null,
    notes: receipt.notes ?? null,
    staffId: receipt.staffCtx.staffId,
    unitCost: unitCost ?? null,
  });
  await alertOnThreshold(tx, bookId, locationId, before.quantity);
  return { averageCost };
}

/**
 * Damaged books coming back (a damaged return): counted apart, not for sale,
 * so the quantity on hand and its value stay as they were.
 */
export async function receiveDamaged(tx: Queryable, change: StockChange): Promise<void> {
  checkQuantity(change.quantity);
  await stock.ensureLevel(tx, change.bookId, change.locationId);
  const level = await lockOrThrow(tx, change.bookId, change.locationId);
  await stock.addDamaged(tx, change.bookId, change.locationId, change.quantity);
  await stock.insertMovement(tx, {
    bookId: change.bookId,
    locationId: change.locationId,
    qtyBefore: level.quantity,
    qtyAfter: level.quantity,
    movementType: 'stock_in',
    reasonCode: change.reasonCode ?? 'damage',
    referenceType: change.referenceType ?? null,
    referenceId: change.referenceId ?? null,
    notes: change.notes ?? null,
    staffId: change.staffCtx.staffId,
    unitCost: null,
  });
}

/**
 * Stock leaving a location: a sale, a confirmed order, an exchange. Returns
 * the average cost it left at, which a sale keeps as its cost of goods.
 */
export async function issueStock(tx: Queryable, issue: StockChange): Promise<{ unitCost: Money }> {
  const { bookId, locationId, quantity } = issue;
  checkQuantity(quantity);
  const allowNegative = await isNegativeStockAllowed();

  const before = await lockOrThrow(tx, bookId, locationId);
  const available = Math.max(0, before.quantity);
  if (!policy.canIssue(available, quantity, allowNegative)) {
    const level = await levelOrThrow(tx, bookId, locationId);
    throw new BusinessError(
      'INSUFFICIENT_STOCK',
      `Insufficient stock for "${level.bookTitle}" at ${level.locationName}. Available: ${available}, Requested: ${quantity}`,
    );
  }

  const after = before.quantity - quantity;
  await stock.updateLevel(tx, bookId, locationId, { quantity: after });
  await stock.insertMovement(tx, {
    bookId,
    locationId,
    qtyBefore: before.quantity,
    qtyAfter: after,
    movementType: 'stock_out',
    reasonCode: issue.reasonCode ?? 'loss',
    referenceType: issue.referenceType ?? null,
    referenceId: issue.referenceId ?? null,
    notes: issue.notes ?? null,
    staffId: issue.staffCtx.staffId,
    unitCost: before.averageCost,
  });
  await alertOnThreshold(tx, bookId, locationId, before.quantity);
  return { unitCost: before.averageCost };
}

/**
 * A manual correction, valued at the average cost so a write-off shows in
 * inventory value; the average itself does not change (owner decision, #21).
 */
async function adjustLevel(tx: Queryable, actor: Actor, adjustment: Adjustment): Promise<{ before: number; after: number }> {
  const { bookId, locationId, delta, reasonCode } = adjustment;
  policy.checkAdjustmentDirection(reasonCode, delta);
  const allowNegative = await isNegativeStockAllowed();

  const before = await lockOrThrow(tx, bookId, locationId);
  policy.checkVersion(before.version, adjustment.version);
  const after = policy.quantityAfterAdjustment(before.quantity, delta, allowNegative);

  await stock.updateLevel(tx, bookId, locationId, { quantity: after });
  await stock.insertMovement(tx, {
    bookId,
    locationId,
    qtyBefore: before.quantity,
    qtyAfter: after,
    movementType: 'adjustment',
    reasonCode,
    referenceType: adjustment.referenceType ?? null,
    referenceId: adjustment.referenceId ?? null,
    notes: adjustment.notes ?? null,
    staffId: actor.staffId,
    unitCost: before.averageCost,
  });
  await alertOnThreshold(tx, bookId, locationId, before.quantity);
  return { before: before.quantity, after };
}

/**
 * Stock moving between two locations of one branch. The units carry the
 * source's average cost into the destination's average; a transfer never
 * takes the source below zero.
 */
export async function moveStock(
  tx: Queryable,
  transfer: TransferStockRequest & { staffCtx: Actor; notes?: string },
): Promise<void> {
  const { bookId, fromLocationId, toLocationId, quantity } = transfer;
  checkQuantity(quantity);
  if (fromLocationId === toLocationId) throw new ValidationError('Source and destination locations must differ');

  const branches = await branchesOf(tx, [fromLocationId, toLocationId]);
  if (branches.size !== 2) throw new NotFoundError('Location');
  if (branches.get(fromLocationId) !== branches.get(toLocationId)) {
    throw new ValidationError('Cannot transfer stock between locations in different branches');
  }

  await stock.ensureLevel(tx, bookId, toLocationId);
  await stock.lockLevels(tx, bookId, [fromLocationId, toLocationId]);
  const source = await lockOrThrow(tx, bookId, fromLocationId);
  policy.checkVersion(source.version, transfer.fromVersion);
  const available = Math.max(0, source.quantity);
  if (available < quantity) {
    throw new BusinessError(
      'INSUFFICIENT_STOCK',
      `Insufficient available stock at source for transfer. Available: ${available}, Requested: ${quantity}`,
    );
  }
  const destination = await lockOrThrow(tx, bookId, toLocationId);

  await stock.updateLevel(tx, bookId, fromLocationId, { quantity: source.quantity - quantity });
  await stock.updateLevel(tx, bookId, toLocationId, {
    quantity: destination.quantity + quantity,
    averageCost: policy.averageCostAfterReceipt(destination.quantity, destination.averageCost, quantity, source.averageCost),
  });

  const transferId = await stock.nextTransferId(tx);
  const shared = {
    bookId,
    referenceType: 'transfer',
    referenceId: transferId,
    notes: transfer.notes ?? `Transfer to location ${toLocationId} [batch ${transferId}]`,
    staffId: transfer.staffCtx.staffId,
    unitCost: source.averageCost,
  };
  await stock.insertMovement(tx, {
    ...shared,
    locationId: fromLocationId,
    qtyBefore: source.quantity,
    qtyAfter: source.quantity - quantity,
    movementType: 'transfer_out',
    reasonCode: 'transfer_out',
  });
  await stock.insertMovement(tx, {
    ...shared,
    locationId: toLocationId,
    qtyBefore: destination.quantity,
    qtyAfter: destination.quantity + quantity,
    movementType: 'transfer_in',
    reasonCode: 'transfer_in',
  });
  await alertOnThreshold(tx, bookId, fromLocationId, source.quantity);
}

/**
 * Fulfilling an order: its reservations are done. The stock left when the
 * order was confirmed, so no stock moves and no history row is written; the
 * order records its own fulfilment (owner decision, #21).
 */
export function fulfillReservations(tx: Queryable, orderId: number | string): Promise<void> {
  return stock.deductReservations(tx, orderId);
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

// ── Manual changes from the inventory screens ────────────────────────────────

/** A manual correction: damage, loss, a return to the shelf, or a count discrepancy. */
export async function adjustStock(actor: Actor, adjustment: Adjustment): Promise<StockLevelRecord> {
  return withTransaction({}, async (tx) => {
    const { before, after } = await adjustLevel(tx, actor, adjustment);
    await audit(tx, actor, 'inventory', adjustment, {
      bookId: adjustment.bookId,
      locationId: adjustment.locationId,
      delta: adjustment.delta,
      reasonCode: adjustment.reasonCode,
      qtyBefore: before,
      qtyAfter: after,
    });
    const level = await levelOrThrow(tx, adjustment.bookId, adjustment.locationId);
    await insertOutboxEvent(tx, 'inventory.adjustment', {
      ...where(level),
      delta: adjustment.delta,
      reasonCode: adjustment.reasonCode,
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
  return withTransaction({ isolationLevel: 'repeatable read' }, async (tx) => {
    await moveStock(tx, { ...transfer, staffCtx: actor });
    const from = await levelOrThrow(tx, transfer.bookId, transfer.fromLocationId);
    const to = await levelOrThrow(tx, transfer.bookId, transfer.toLocationId);
    await insertOutboxEvent(tx, 'inventory.transfer_completed', {
      bookId: from.bookId,
      bookTitle: from.bookTitle,
      fromLocationId: from.locationId,
      fromLocationName: from.locationName,
      toLocationId: to.locationId,
      toLocationName: to.locationName,
      branchId: from.branchId,
      quantity: transfer.quantity,
    });
    return { from, to };
  });
}

/** Stock received by hand (procurement receiving books it through its own flow). */
export async function stockIn(actor: Actor, receipt: StockInRequest): Promise<StockLevelRecord> {
  const { bookId, locationId, quantity } = receipt;
  const referenceType = receipt.referenceType ?? 'manual';

  return withTransaction({}, async (tx) => {
    await stock.ensureLevel(tx, bookId, locationId);
    const before = await lockOrThrow(tx, bookId, locationId);
    policy.checkVersion(before.version, receipt.version);

    await receiveStock(tx, {
      bookId,
      locationId,
      quantity,
      staffCtx: actor,
      referenceType,
      referenceId: receipt.referenceId,
      notes: receipt.notes,
    });
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
    await insertOutboxEvent(tx, 'inventory.stock_in', { ...where(level), quantity });
    return level;
  });
}

/** Stock issued by hand; sales take stock out through POS and orders. */
export async function stockOut(actor: Actor, issue: StockOutRequest): Promise<StockLevelRecord> {
  const { bookId, locationId, quantity, referenceType } = issue;

  return withTransaction({}, async (tx) => {
    const before = await lockOrThrow(tx, bookId, locationId);
    policy.checkVersion(before.version, issue.version);

    await issueStock(tx, {
      bookId,
      locationId,
      quantity,
      staffCtx: actor,
      referenceType,
      referenceId: issue.referenceId,
      notes: issue.notes,
    });
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
    await insertOutboxEvent(tx, 'inventory.stock_out', {
      ...where(level),
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
