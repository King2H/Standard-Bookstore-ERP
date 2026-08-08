/**
 * InventoryTransactionService — Centralized Inventory Mutation Pipeline
 *
 * This is the SINGLE source of truth for all inventory.quantity mutations.
 * NO other module may execute `UPDATE inventory SET quantity = ...` directly.
 *
 * AUDIT — Direct inventory mutations found and replaced (Task 3.1):
 *   pos.service.ts:436       — createTransaction deduction (no reservation check)
 *   pos.service.ts:710       — void/restore stock_in
 *   orders.service.ts:425    — confirm deduction (no reservation-aware check)
 *   orders.service.ts:615    — cancel restoration
 *   procurement.service.ts:774 — receivePO stock_in
 *   returns.service.ts:143   — createReturn stock_in (bypasses shared service)
 *   exchanges.service.ts:282 — createExchange incoming stock_in
 *   exchanges.service.ts:292 — createExchange outgoing stock_out (no reservation check)
 *   exchanges.service.ts:714 — settleExchange incoming stock_in
 *   exchanges.service.ts:757 — settleExchange outgoing stock_out
 *   inventory.service.ts:340/345 — transferStock (no reservation check, no reference fields)
 *   inventory.service.ts:623 — stockIn inline UPDATE
 *   inventory.service.ts:734 — stockOut inline UPDATE (no reservation check)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.14, 2.18, 2.19, 2.20, 2.21, 2.22, 3.4, 3.6, 3.8, 3.12
 */

import { PoolClient } from 'pg';
import { db } from '../../db/index.js';
import { BusinessError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isNegativeStockAllowed } from '../config/config.service.js';
import { insertOutbox } from '../../lib/outbox.js';
import type { StaffCtx, ReasonCode } from './inventory.service.js';

// ── Feature flag cache (shared with inventory.service.ts logic) ───────────────
let _hasReservationsTable: boolean | null = null;
async function hasReservationsTable(client?: PoolClient): Promise<boolean> {
  if (_hasReservationsTable !== null) return _hasReservationsTable;
  try {
    const q = client ?? db;
    const r = await q.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1`,
    );
    _hasReservationsTable = r.rows.length > 0;
  } catch {
    _hasReservationsTable = false;
  }
  return _hasReservationsTable;
}

/** Reset the feature-flag cache — useful in tests. */
export function resetReservationsTableCache(): void {
  _hasReservationsTable = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AvailableStock {
  quantity: number;   // raw inventory.quantity
  reserved: number;   // SUM(active reservations)
  available: number;  // quantity - reserved
}

interface BaseParams {
  bookId: number;
  locationId: number;
  staffCtx: StaffCtx;
  referenceType?: string;
  referenceId?: number | string;
  notes?: string;
}

export interface StockInParams extends BaseParams {
  quantity: number;
  /** Caller must supply movement_type context */
  reasonCode?: ReasonCode;
  /**
   * Per-unit cost basis for this specific receiving event (e.g. the
   * Customer Allowance Value for a Virtual Exchange Receiving — see
   * exchanges.service.ts createExchange()). Optional and unrelated to most
   * callers (procurement receiving establishes cost via po_line_items, not
   * here); when supplied it must be > 0 — "Valuation Integrity: do not allow
   * zero-cost or unvalued inventory entries into stock." Persisted on the
   * inventory_history row and consumed by costBasis.ts's cost-basis
   * fallback for books that have never been procured.
   */
  unitCost?: number;
}

export interface StockOutParams extends BaseParams {
  quantity: number;
  /** Optional version for optimistic locking. When omitted, SELECT FOR UPDATE is used. */
  version?: number;
  reasonCode?: ReasonCode;
}

export interface AdjustParams extends BaseParams {
  delta: number;
  reasonCode: ReasonCode;
  /** Optimistic lock — required for adjust */
  version: number;
}

export interface TransferParams {
  bookId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  fromVersion: number;
  staffCtx: StaffCtx;
  notes?: string;
}

// ── getAvailableStock ─────────────────────────────────────────────────────────
/**
 * Returns reservation-aware available stock for a (book, location) pair.
 * Falls back to raw quantity when inventory_reservations table doesn't exist.
 * Requirements: 2.3, 2.19, 4.2
 */
export async function getAvailableStock(
  bookId: number,
  locationId: number,
  client?: PoolClient,
): Promise<AvailableStock> {
  const q = client ?? db;

  if (await hasReservationsTable(client)) {
    // available = quantity, NOT quantity - reserved.
    //
    // orders.service.ts confirm() inserts the 'reserved' row and calls
    // stockOut() (which decrements inventory.quantity) in the same DB
    // transaction, every time -- there is no code path where a committed
    // 'reserved' row exists without inventory.quantity already reflecting
    // that deduction. Subtracting `reserved` again here double-counts it:
    // every confirmed-but-unfulfilled order would make this function
    // under-report available stock by its own quantity, on top of the
    // deduction that already happened, potentially rejecting legitimate
    // sales (INSUFFICIENT_STOCK) with real stock still on hand.
    //
    // `reserved` is still returned as an informational field (how much is
    // confirmed-but-not-yet-fulfilled) but is no longer subtracted.
    const result = await q.query(
      `SELECT i.quantity,
              COALESCE(SUM(r.quantity), 0)::int AS reserved,
              i.quantity::int AS available
       FROM inventory i
       LEFT JOIN inventory_reservations r
         ON r.book_id = i.book_id
        AND r.location_id = i.location_id
        AND r.status = 'reserved'
       WHERE i.book_id = $1 AND i.location_id = $2
       GROUP BY i.quantity`,
      [bookId, locationId],
    );
    if (!result.rows.length) return { quantity: 0, reserved: 0, available: 0 };
    const row = result.rows[0] as { quantity: number; reserved: number; available: number };
    return {
      quantity: Number(row.quantity),
      reserved: Number(row.reserved),
      available: Math.max(0, Number(row.available)),
    };
  }

  // Graceful degradation — no reservations table yet
  const result = await q.query(
    `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  if (!result.rows.length) return { quantity: 0, reserved: 0, available: 0 };
  const qty = Math.max(0, Number(result.rows[0].quantity));
  return { quantity: qty, reserved: 0, available: qty };
}

/**
 * Get available stock for a list of books, optionally scoped to a location or branch.
 * Returns a map of bookId -> available (== quantity; see getAvailableStock()
 * above for why reservations are no longer subtracted).
 */
export async function getStockQuantities(
  bookIds: number[],
  locationId?: number | null,
  branchId?: number | null,
  client?: PoolClient,
): Promise<Record<number, number>> {
  const q = client ?? db;
  if (!bookIds || bookIds.length === 0) return {};

  const useRes = await hasReservationsTable(client);

  if (useRes) {
    const result = await q.query(
      `SELECT inv.book_id,
              COALESCE(SUM(inv.quantity), 0) AS available
       FROM inventory inv
       WHERE inv.book_id = ANY($1)
         AND (
           ($2::integer IS NOT NULL AND inv.location_id = $2::integer) OR
           ($2::integer IS NULL AND $3::integer IS NOT NULL AND inv.location_id IN (SELECT id FROM locations WHERE branch_id = $3::integer)) OR
           ($2::integer IS NULL AND $3::integer IS NULL)
         )
       GROUP BY inv.book_id`,
      [bookIds, locationId ?? null, branchId ?? null],
    );
    const map: Record<number, number> = {};
    for (const r of result.rows) {
      map[Number(r.book_id)] = Math.max(0, Number(r.available ?? 0));
    }
    // ensure all requested ids exist in map
    for (const id of bookIds) if (map[id] == null) map[id] = 0;
    return map;
  }

  // Fallback: no reservations table — sum raw quantities
  const result = await q.query(
    `SELECT inv.book_id, COALESCE(SUM(inv.quantity), 0) AS available
     FROM inventory inv
     WHERE inv.book_id = ANY($1)
       AND (
         ($2::integer IS NOT NULL AND inv.location_id = $2::integer) OR
         ($2::integer IS NULL AND $3::integer IS NOT NULL AND inv.location_id IN (SELECT id FROM locations WHERE branch_id = $3::integer)) OR
         ($2::integer IS NULL AND $3::integer IS NULL)
       )
     GROUP BY inv.book_id`,
    [bookIds, locationId ?? null, branchId ?? null],
  );
  const map: Record<number, number> = {};
  for (const r of result.rows) map[Number(r.book_id)] = Math.max(0, Number(r.available ?? 0));
  for (const id of bookIds) if (map[id] == null) map[id] = 0;
  return map;
}

// ── Internal helper: emit low-stock / out-of-stock notifications ──────────────
async function emitStockNotifications(
  bookId: number,
  locationId: number,
  newQty: number,
  bookTitle: string,
  locationName: string,
  branchId: number,
): Promise<void> {
  try {
    const notifClient = await db.connect();
    try {
      await notifClient.query('BEGIN');
      const rpRes = await notifClient.query(
        'SELECT reorder_point FROM inventory WHERE book_id = $1 AND location_id = $2',
        [bookId, locationId],
      );
      const rp = (rpRes.rows[0]?.reorder_point as number) ?? 5;
      if (newQty === 0) {
        await insertOutbox(notifClient, 'inventory.out_of_stock', {
          bookId, bookTitle, locationId, locationName, branchId, quantity: newQty,
        });
      } else if (newQty <= rp) {
        await insertOutbox(notifClient, 'inventory.low_stock', {
          bookId, bookTitle, locationId, locationName, branchId, quantity: newQty, reorderPoint: rp,
        });
      }
      await notifClient.query('COMMIT');
    } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
  } catch { /* non-fatal — notification failure must never roll back the business transaction */ }
}

// ── Internal helper: fetch book/location metadata for notifications ───────────
async function fetchMeta(bookId: number, locationId: number): Promise<{ bookTitle: string; locationName: string; branchId: number }> {
  const [bookRes, locRes] = await Promise.all([
    db.query('SELECT title FROM books WHERE id = $1', [bookId]),
    db.query('SELECT name, branch_id FROM locations WHERE id = $1', [locationId]),
  ]);
  return {
    bookTitle: bookRes.rows[0]?.title ?? String(bookId),
    locationName: locRes.rows[0]?.name ?? String(locationId),
    branchId: locRes.rows[0]?.branch_id as number ?? 0,
  };
}

// ── getBookAvailability ───────────────────────────────────────────────────────
/**
 * Returns per-location availability for a list of books at a given location.
 * Used by POS, Orders, and Exchanges to enrich book search results with
 * live stock data WITHOUT coupling the Catalog module to inventory.
 *
 * Returns: BookAvailability[] — one entry per (book, location) pair.
 */
export interface BookAvailability {
  bookId: number;
  locationId: number;
  locationName: string;
  onHand: number;
  reserved: number;
  available: number;
}

export async function getBookAvailability(
  bookIds: number[],
  locationId: number,
): Promise<BookAvailability[]> {
  if (!bookIds || bookIds.length === 0) return [];

  const useRes = await hasReservationsTable();

  if (useRes) {
    // available = on_hand (quantity), not quantity - reserved — see
    // getAvailableStock() above for why: reservations are inserted in the
    // same transaction as the stockOut() that already deducted quantity, so
    // subtracting them again here double-counts every confirmed-but-
    // unfulfilled order, understating what POS/Orders/Exchanges show staff
    // as in-stock.
    const result = await db.query(
      `SELECT
         i.book_id,
         i.location_id,
         l.name AS location_name,
         i.quantity AS on_hand,
         COALESCE((
           SELECT SUM(r.quantity)::int FROM inventory_reservations r
           WHERE r.book_id = i.book_id AND r.location_id = i.location_id AND r.status = 'reserved'
         ), 0) AS reserved,
         GREATEST(0, i.quantity) AS available
       FROM inventory i
       JOIN locations l ON l.id = i.location_id
       WHERE i.book_id = ANY($1) AND i.location_id = $2`,
      [bookIds, locationId],
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      bookId:       Number(r.book_id),
      locationId:   Number(r.location_id),
      locationName: String(r.location_name),
      onHand:       Number(r.on_hand),
      reserved:     Number(r.reserved),
      available:    Number(r.available),
    }));
  }

  // Fallback: no reservations table — return raw quantity, no reservations
  const result = await db.query(
    `SELECT i.book_id, i.location_id, l.name AS location_name, i.quantity AS on_hand
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
     WHERE i.book_id = ANY($1) AND i.location_id = $2`,
    [bookIds, locationId],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    bookId:       Number(r.book_id),
    locationId:   Number(r.location_id),
    locationName: String(r.location_name),
    onHand:       Number(r.on_hand),
    reserved:     0,
    available:    Number(r.on_hand),
  }));
}

// ── stockIn ───────────────────────────────────────────────────────────────────
/**
 * Increases inventory.quantity at the given location.
 * Always succeeds (stock_in never reduces below current).
 * Writes a complete inventory_history row.
 *
 * Requirements: 2.1, 2.10, 2.11, 2.12, 2.14
 */
export async function stockIn(
  params: StockInParams,
  externalClient?: PoolClient,
): Promise<void> {
  const { bookId, locationId, quantity, referenceType, referenceId, notes, staffCtx, unitCost } = params;
  const reasonCode = params.reasonCode ?? 'return';

  if (quantity <= 0) throw new ValidationError('stockIn quantity must be positive');
  if (unitCost !== undefined && !(unitCost > 0)) {
    throw new ValidationError('stockIn unitCost must be positive when provided — zero/unvalued stock entries are not allowed');
  }

  const useExternal = !!externalClient;
  const client = externalClient ?? await db.connect();

  try {
    if (!useExternal) await client.query('BEGIN');

    // Acquire row lock
    const current = await client.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
      [bookId, locationId],
    );
    if (!current.rows.length) throw new NotFoundError(`Inventory record for book ${bookId} at location ${locationId}`);

    const qtyBefore = Number(current.rows[0].quantity);
    const qtyAfter = qtyBefore + quantity;

    await client.query(
      `UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3`,
      [qtyAfter, bookId, locationId],
    );

    await client.query(
      `INSERT INTO inventory_history
         (book_id, location_id, qty_before, qty_after, delta,
          reason_code, movement_type, reference_type, reference_id, notes, staff_id, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, 'stock_in', $7, $8, $9, $10, $11)`,
      [
        bookId, locationId, qtyBefore, qtyAfter, quantity,
        reasonCode,
        referenceType ?? null,
        referenceId != null ? String(referenceId) : null,
        notes ?? null,
        staffCtx.staffId,
        unitCost != null ? unitCost.toFixed(2) : null,
      ],
    );

    if (!useExternal) await client.query('COMMIT');

    // Emit notifications after commit (non-blocking)
    if (!useExternal) {
      const meta = await fetchMeta(bookId, locationId);
      await emitStockNotifications(bookId, locationId, qtyAfter, meta.bookTitle, meta.locationName, meta.branchId);
    }
  } catch (err) {
    if (!useExternal) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!useExternal) client.release();
  }
}

// ── stockOut ──────────────────────────────────────────────────────────────────
/**
 * Decreases inventory.quantity at the given location.
 * Uses reservation-aware availability: available = quantity - SUM(active_reservations).
 * Rejects with INSUFFICIENT_STOCK when available < requested.
 * Respects isNegativeStockAllowed() config.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.14, 2.19
 */
export async function stockOut(
  params: StockOutParams,
  externalClient?: PoolClient,
): Promise<void> {
  const { bookId, locationId, quantity, referenceType, referenceId, notes, staffCtx } = params;
  const reasonCode = params.reasonCode ?? 'loss';

  if (quantity <= 0) throw new ValidationError('stockOut quantity must be positive');

  const allowNeg = await isNegativeStockAllowed();

  const useExternal = !!externalClient;
  const client = externalClient ?? await db.connect();

  try {
    if (!useExternal) await client.query('BEGIN');

    // Acquire row lock
    const current = await client.query(
      `SELECT quantity, version FROM inventory
       WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
      [bookId, locationId],
    );
    if (!current.rows.length) throw new NotFoundError(`Inventory record for book ${bookId} at location ${locationId}`);

    const qtyBefore = Number(current.rows[0].quantity);

    // Reservation-aware availability check (Requirement 2.3)
    const stock = await getAvailableStock(bookId, locationId, client);

    if (!allowNeg && stock.available < quantity) {
      const bookRes = await client.query('SELECT title FROM books WHERE id = $1', [bookId]);
      const bookTitle = bookRes.rows[0]?.title ?? `Book ${bookId}`;
      const locRes = await client.query('SELECT name FROM locations WHERE id = $1', [locationId]);
      const locName = locRes.rows[0]?.name ?? `Location ${locationId}`;
      throw new BusinessError(
        'INSUFFICIENT_STOCK',
        `Insufficient stock for "${bookTitle}" at ${locName}. Available: ${stock.available}, Requested: ${quantity}`,
      );
    }

    const qtyAfter = Math.max(0, qtyBefore - quantity);

    await client.query(
      `UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3`,
      [qtyAfter, bookId, locationId],
    );

    await client.query(
      `INSERT INTO inventory_history
         (book_id, location_id, qty_before, qty_after, delta,
          reason_code, movement_type, reference_type, reference_id, notes, staff_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'stock_out', $7, $8, $9, $10)`,
      [
        bookId, locationId, qtyBefore, qtyAfter, -quantity,
        reasonCode,
        referenceType ?? null,
        referenceId != null ? String(referenceId) : null,
        notes ?? null,
        staffCtx.staffId,
      ],
    );

    if (!useExternal) await client.query('COMMIT');

    if (!useExternal) {
      const meta = await fetchMeta(bookId, locationId);
      await emitStockNotifications(bookId, locationId, qtyAfter, meta.bookTitle, meta.locationName, meta.branchId);
    }
  } catch (err) {
    if (!useExternal) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!useExternal) client.release();
  }
}

// ── adjust ────────────────────────────────────────────────────────────────────
/**
 * Manual inventory adjustment with optimistic locking.
 * Accepts optional referenceType/referenceId for traceability.
 *
 * Requirements: 2.1, 2.14, 2.21, 3.4, 3.15
 */
export async function adjust(
  params: AdjustParams,
  externalClient?: PoolClient,
): Promise<void> {
  const { bookId, locationId, delta, reasonCode, version, referenceType, referenceId, notes, staffCtx } = params;

  if (delta === 0) throw new ValidationError('Adjustment delta cannot be zero');

  const allowNeg = await isNegativeStockAllowed();

  const useExternal = !!externalClient;
  const client = externalClient ?? await db.connect();

  try {
    if (!useExternal) await client.query('BEGIN');

    const current = await client.query(
      `SELECT quantity, version FROM inventory
       WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
      [bookId, locationId],
    );
    if (!current.rows.length) throw new NotFoundError(`Inventory record for book ${bookId} at location ${locationId}`);

    const currentVersion = Number(current.rows[0].version);
    const qtyBefore = Number(current.rows[0].quantity);

    // Optimistic lock check (Requirement 2.18, 3.15)
    if (currentVersion !== version) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'Inventory was modified by another operation. Please refresh and retry.',
        { currentVersion, providedVersion: version },
      );
    }

    const qtyAfter = qtyBefore + delta;
    if (!allowNeg && qtyAfter < 0) {
      throw new BusinessError('INSUFFICIENT_STOCK', `Cannot reduce stock below 0. Current: ${qtyBefore}, Delta: ${delta}`);
    }

    const updated = await client.query(
      `UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3 AND version = $4
       RETURNING quantity`,
      [Math.max(0, qtyAfter), bookId, locationId, version],
    );
    if (!updated.rows.length) {
      throw new ConflictError('VERSION_CONFLICT', 'Concurrent modification detected. Please retry.');
    }

    const finalQty = Number(updated.rows[0].quantity);

    await client.query(
      `INSERT INTO inventory_history
         (book_id, location_id, qty_before, qty_after, delta,
          reason_code, movement_type, reference_type, reference_id, notes, staff_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'adjustment', $7, $8, $9, $10)`,
      [
        bookId, locationId, qtyBefore, finalQty, delta,
        reasonCode,
        referenceType ?? null,
        referenceId != null ? String(referenceId) : null,
        notes ?? null,
        staffCtx.staffId,
      ],
    );

    if (!useExternal) await client.query('COMMIT');

    if (!useExternal) {
      const meta = await fetchMeta(bookId, locationId);
      await emitStockNotifications(bookId, locationId, finalQty, meta.bookTitle, meta.locationName, meta.branchId);
    }
  } catch (err) {
    if (!useExternal) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!useExternal) client.release();
  }
}

// ── transfer ──────────────────────────────────────────────────────────────────
/**
 * Transfers stock between two locations in the same branch.
 * Validates source available stock (excluding reservations) before deducting.
 * Writes paired transfer_out / transfer_in history rows with a shared reference_id.
 *
 * Requirements: 2.1, 2.14, 2.22, 3.16
 */
export async function transfer(
  params: TransferParams,
  externalClient?: PoolClient,
): Promise<void> {
  const { bookId, fromLocationId, toLocationId, quantity, fromVersion, staffCtx, notes } = params;

  if (quantity <= 0) throw new ValidationError('Transfer quantity must be positive');
  if (fromLocationId === toLocationId) throw new ValidationError('Source and destination locations must differ');

  // Verify same branch
  const locCheck = await db.query(
    `SELECT id, branch_id FROM locations WHERE id = ANY($1)`,
    [[fromLocationId, toLocationId]],
  );
  if (locCheck.rows.length !== 2) throw new NotFoundError('One or both locations not found');
  const branchIds = locCheck.rows.map((r: { branch_id: number }) => r.branch_id);
  if (branchIds[0] !== branchIds[1]) {
    throw new ValidationError('Cannot transfer stock between locations in different branches');
  }

  const useExternal = !!externalClient;
  const client = externalClient ?? await db.connect();

  try {
    if (!useExternal) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    // Deadlock-safe lock order (lower id first) — Requirement 3.16
    const lockOrder = fromLocationId < toLocationId
      ? [fromLocationId, toLocationId]
      : [toLocationId, fromLocationId];

    await client.query(
      `SELECT quantity, version FROM inventory
       WHERE book_id = $1 AND location_id = ANY($2) FOR UPDATE`,
      [bookId, lockOrder],
    );

    // Read source
    const src = await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, fromLocationId],
    );
    if (!src.rows.length) throw new NotFoundError('Source inventory record');

    const srcVersion = Number(src.rows[0].version);
    const srcQty = Number(src.rows[0].quantity);

    // Optimistic lock on source
    if (srcVersion !== fromVersion) {
      throw new ConflictError('VERSION_CONFLICT', 'Source inventory was modified. Please refresh and retry.', {
        currentVersion: srcVersion, providedVersion: fromVersion,
      });
    }

    // Reservation-aware source availability check (Requirement 2.22)
    const stock = await getAvailableStock(bookId, fromLocationId, client);
    if (stock.available < quantity) {
      throw new BusinessError(
        'INSUFFICIENT_STOCK',
        `Insufficient available stock at source for transfer. Available: ${stock.available}, Requested: ${quantity}`,
      );
    }

    // Init destination if missing
    await client.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
      [bookId, toLocationId],
    );

    const dst = await client.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, toLocationId],
    );
    const dstQty = Number(dst.rows[0].quantity);

    // Apply both updates
    await client.query(
      `UPDATE inventory SET quantity = quantity - $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3`,
      [quantity, bookId, fromLocationId],
    );
    await client.query(
      `UPDATE inventory SET quantity = quantity + $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3`,
      [quantity, bookId, toLocationId],
    );

    // Shared transfer batch ID for traceability (Requirement 2.22).
    // Bug fix: this used to be a human-readable string (`TRF-${Date.now()}-...`)
    // that was computed but never actually placed in the reference_type/
    // reference_id columns below (both were hardcoded NULL) -- it only ended
    // up embedded in the free-text `notes` string, making it unqueryable.
    // reference_id is bigint (a string batch id wouldn't fit) and 'transfer'
    // wasn't even an allowed reference_type value (see migration
    // 1700000044_transfer_reference_type). Fixed both: extended the CHECK
    // constraint, and generate a real bigint batch id (independent of either
    // row's own id, so it can be shared identically by both rows) from the
    // table's own id sequence.
    const batchIdRes = await client.query(`SELECT nextval('inventory_history_id_seq') AS id`);
    const transferBatchId = String(batchIdRes.rows[0].id);

    await client.query(
      `INSERT INTO inventory_history
         (book_id, location_id, qty_before, qty_after, delta,
          reason_code, movement_type, reference_type, reference_id, notes, staff_id)
       VALUES
         ($1, $2, $3, $4, $5, 'transfer_out', 'transfer_out', 'transfer', $8, $6, $7),
         ($1, $9, $10, $11, $12, 'transfer_in', 'transfer_in', 'transfer', $8, $6, $7)`,
      [
        bookId,
        fromLocationId, srcQty, srcQty - quantity, -quantity,
        notes ?? `Transfer to location ${toLocationId} [batch ${transferBatchId}]`,
        staffCtx.staffId,
        transferBatchId,
        toLocationId, dstQty, dstQty + quantity, quantity,
      ],
    );

    if (!useExternal) await client.query('COMMIT');

    // Emit transfer notification (non-blocking)
    if (!useExternal) {
      try {
        const locRes = await db.query(
          'SELECT id, name, branch_id FROM locations WHERE id = ANY($1)',
          [[fromLocationId, toLocationId]],
        );
        const locMap = new Map(locRes.rows.map((r: Record<string, unknown>) => [r.id as number, r]));
        const fromLoc = locMap.get(fromLocationId);
        const toLoc = locMap.get(toLocationId);
        const bookRes = await db.query('SELECT title FROM books WHERE id = $1', [bookId]);
        const bookTitle = bookRes.rows[0]?.title ?? String(bookId);
        const notifClient = await db.connect();
        try {
          await notifClient.query('BEGIN');
          await insertOutbox(notifClient, 'inventory.transfer_completed', {
            bookId, bookTitle,
            fromLocationId, fromLocationName: fromLoc?.name ?? String(fromLocationId),
            toLocationId, toLocationName: toLoc?.name ?? String(toLocationId),
            branchId: fromLoc?.branch_id ?? staffCtx.branchId, quantity,
          });
          await notifClient.query('COMMIT');
        } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    if (!useExternal) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!useExternal) client.release();
  }
}

// ── fulfillReservation ────────────────────────────────────────────────────────
/**
 * Transitions inventory_reservations from 'reserved' → 'deducted' when an order
 * is fulfilled, and writes one inventory_history row per line item for audit.
 *
 * KEY CONTRACT: does NOT modify inventory.quantity. Stock was already physically
 * deducted at confirm() time via stockOut(). This function only:
 *   1. Writes an audit inventory_history row per line item (delta = 0, so qty
 *      unchanged — the row is a fulfillment audit trail, not a mutation).
 *   2. Marks all 'reserved' reservations for the order as 'deducted'.
 *
 * Accepts an optional externalClient to participate in the caller's transaction.
 *
 * Requirements: 2.7, 2.8, 2.9, 2.10
 */
export interface FulfillReservationParams {
  orderId: number | string;
  locationId: number;
  lineItems: Array<{ bookId: number; qtyReserved: number }>;
  staffCtx: StaffCtx;
}

export async function fulfillReservation(
  params: FulfillReservationParams,
  externalClient?: PoolClient,
): Promise<void> {
  const { orderId, locationId, lineItems, staffCtx } = params;

  const useExternal = !!externalClient;
  const client = externalClient ?? await db.connect();

  try {
    if (!useExternal) await client.query('BEGIN');

    for (const item of lineItems) {
      if (item.qtyReserved <= 0) continue;

      // Read current inventory.quantity — no UPDATE, qty is already correct
      const invRow = await client.query(
        `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
        [item.bookId, locationId],
      );
      const currentQty = invRow.rows.length > 0
        ? Number(invRow.rows[0].quantity)
        : 0;

      // Write audit history row: delta = 0 (no physical change), records the
      // fulfillment event so the audit trail shows order_fulfilled transitions.
      await client.query(
        `INSERT INTO inventory_history
           (book_id, location_id, qty_before, qty_after, delta,
            reason_code, movement_type, reference_type, reference_id, notes, staff_id)
         VALUES ($1, $2, $3, $3, 0, 'return', 'stock_out', 'order_fulfilled', $4, $5, $6)`,
        [
          item.bookId,
          locationId,
          currentQty,
          String(orderId),
          `Order fulfilled – reservation deducted for order ${String(orderId)}`,
          staffCtx.staffId,
        ],
      );
    }

    // Transition all 'reserved' reservations for this order to 'deducted'
    // Graceful degradation: if the table doesn't exist, skip silently
    const hasResTable = await hasReservationsTable(client);
    if (hasResTable) {
      await client.query(
        `UPDATE inventory_reservations
            SET status = 'deducted', updated_at = now()
          WHERE order_id = $1
            AND status = 'reserved'`,
        [String(orderId)],
      );
    }

    if (!useExternal) await client.query('COMMIT');
  } catch (err) {
    if (!useExternal) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!useExternal) client.release();
  }
}
