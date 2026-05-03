import { db } from '../../db/index.js';
import { BusinessError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';

export type ReferenceType = 'purchase_order' | 'return' | 'adjustment' | 'manual' | 'initial_stock';
import { isNegativeStockAllowed } from '../config/config.service.js';
import { insertOutbox } from '../../lib/outbox.js';

// ── Feature flag: inventory_reservations table ────────────────────────────────
// Checked once and cached. Falls back gracefully when migration 33 hasn't run.
let _hasReservationsTable: boolean | null = null;
async function hasReservationsTable(): Promise<boolean> {
  if (_hasReservationsTable !== null) return _hasReservationsTable;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1`,
    );
    _hasReservationsTable = r.rows.length > 0;
  } catch {
    _hasReservationsTable = false;
  }
  return _hasReservationsTable;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export type ReasonCode = 'damage' | 'loss' | 'return' | 'correction' | 'transfer_in' | 'transfer_out' | 'initial';
export type MovementType = 'stock_in' | 'stock_out' | 'transfer_in' | 'transfer_out' | 'adjustment';

export interface InventoryRow {
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  locationId: number;
  locationName: string;
  branchId: number;
  quantity: number;
  reorderPoint: number;
  version: number;
  isLowStock: boolean;
  updatedAt: string;
}

export interface HistoryRow {
  id: string;
  bookId: number;
  bookTitle: string;
  locationId: number;
  locationName: string;
  qtyBefore: number;
  qtyAfter: number;
  delta: number;
  movementType: MovementType;
  reasonCode: ReasonCode;
  referenceType: string | null;
  referenceId: string | null;
  notes: string | null;
  staffId: number;
  staffUsername: string;
  createdAt: string;
}

// ── Initialize ────────────────────────────────────────────────────────────────
// Idempotent — called when a new book or location is created.

export async function initializeInventory(bookId: number, locationId: number): Promise<void> {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, 0, 5, 0)
     ON CONFLICT DO NOTHING`,
    [bookId, locationId],
  );
}

// ── List inventory for a branch ───────────────────────────────────────────────

export async function listInventory(opts: {
  branchId: number;
  locationId?: number;
  bookId?: number;
  lowStockOnly?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: InventoryRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ['l.branch_id = $1'];
  const params: unknown[] = [opts.branchId];
  let p = 2;

  if (opts.locationId) { conditions.push(`i.location_id = $${p++}`); params.push(opts.locationId); }
  if (opts.bookId) { conditions.push(`i.book_id = $${p++}`); params.push(opts.bookId); }
  if (opts.lowStockOnly) { conditions.push(`i.quantity <= i.reorder_point`); }
  if (opts.q) {
    conditions.push(`(lower(b.title) LIKE lower($${p}) OR b.isbn LIKE $${p})`);
    params.push(`%${opts.q.trim()}%`); p++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM inventory i JOIN locations l ON l.id = i.location_id JOIN books b ON b.id = i.book_id ${where}`, params),
    db.query(
      `SELECT i.book_id, b.title AS book_title, b.isbn AS book_isbn,
              i.location_id, l.name AS location_name, l.branch_id,
              i.quantity, i.reorder_point, i.version, i.updated_at,
              (i.quantity <= i.reorder_point) AS is_low_stock
       FROM inventory i
       JOIN locations l ON l.id = i.location_id
       JOIN books b ON b.id = i.book_id
       ${where}
       ORDER BY b.title ASC, l.name ASC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, pageSize, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(mapInventoryRow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── Adjust stock ──────────────────────────────────────────────────────────────
// Optimistic locking: caller must pass the current version.
// Returns 409 VERSION_CONFLICT if version has changed since last read.

export async function adjustStock(opts: {
  bookId: number;
  locationId: number;
  delta: number;
  reasonCode: ReasonCode;
  notes?: string;
  version: number;
  staffCtx: StaffCtx;
}): Promise<InventoryRow> {
  const { bookId, locationId, delta, reasonCode, notes, version, staffCtx } = opts;

  const validReasons: ReasonCode[] = ['damage', 'loss', 'return', 'correction'];
  if (!validReasons.includes(reasonCode)) {
    throw new ValidationError(`Invalid reason code. Must be one of: ${validReasons.join(', ')}`);
  }
  if (delta === 0) throw new ValidationError('Delta cannot be zero');

  // Check negative stock policy before acquiring lock
  if (delta < 0) {
    const allowNeg = await isNegativeStockAllowed();
    if (!allowNeg) {
      const current = await db.query(
        `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
        [bookId, locationId],
      );
      if (!current.rows.length) throw new NotFoundError('Inventory record');
      const qty = current.rows[0].quantity as number;
      if (qty + delta < 0) {
        throw new BusinessError('INSUFFICIENT_STOCK', `Cannot reduce stock below 0. Current: ${qty}, Delta: ${delta}`);
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Read current row with lock
    const current = await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
      [bookId, locationId],
    );
    if (!current.rows.length) throw new NotFoundError('Inventory record');

    const currentVersion = current.rows[0].version as number;
    const currentQty = current.rows[0].quantity as number;

    // Optimistic lock check
    if (currentVersion !== version) {
      throw new ConflictError('VERSION_CONFLICT', 'Inventory was modified by another operation. Please refresh and retry.', { currentVersion, providedVersion: version });
    }

    const newQty = currentQty + delta;
    if (newQty < 0) {
      throw new BusinessError('INSUFFICIENT_STOCK', `Cannot reduce stock below 0. Current: ${currentQty}, Delta: ${delta}`);
    }

    // Apply update
    const updated = await client.query(
      `UPDATE inventory
       SET quantity = $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3 AND version = $4
       RETURNING quantity, version, reorder_point, updated_at`,
      [newQty, bookId, locationId, version],
    );
    if (!updated.rows.length) {
      throw new ConflictError('VERSION_CONFLICT', 'Concurrent modification detected. Please retry.');
    }

    // Record history
    await client.query(
      `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, notes, staff_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'adjustment', $7, $8)`,
      [bookId, locationId, currentQty, newQty, delta, reasonCode, notes ?? null, staffCtx.staffId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'inventory', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, `${bookId}:${locationId}`, staffCtx.branchId,
       JSON.stringify({ bookId, locationId, delta, reasonCode, qtyBefore: currentQty, qtyAfter: newQty })],
    );

    await client.query('COMMIT');

    // Emit notification event (non-blocking — failure must not affect the business operation)
    const locationRes = await db.query('SELECT name, branch_id FROM locations WHERE id = $1', [locationId]);
    const locationName = locationRes.rows[0]?.name ?? String(locationId);
    const branchIdForNotif = locationRes.rows[0]?.branch_id ?? staffCtx.branchId;
    const bookRes = await db.query('SELECT title FROM books WHERE id = $1', [bookId]);
    const bookTitle = bookRes.rows[0]?.title ?? String(bookId);
    try {
      const notifClient = await db.connect();
      try {
        await notifClient.query('BEGIN');
        await insertOutbox(notifClient, 'inventory.adjustment', {
          bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif,
          delta, reasonCode, notes: notes ?? null,
        });
        // Check low-stock / out-of-stock after adjustment
        const invCheck = await notifClient.query(
          'SELECT quantity, reorder_point FROM inventory WHERE book_id = $1 AND location_id = $2',
          [bookId, locationId],
        );
        if (invCheck.rows.length) {
          const qty = invCheck.rows[0].quantity as number;
          const rp = invCheck.rows[0].reorder_point as number;
          if (qty === 0) {
            await insertOutbox(notifClient, 'inventory.out_of_stock', { bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity: qty });
          } else if (qty <= rp) {
            await insertOutbox(notifClient, 'inventory.low_stock', { bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity: qty, reorderPoint: rp });
          }
        }
        await notifClient.query('COMMIT');
      } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
    } catch { /* notification failure is non-fatal */ }

    // Return updated row
    const row = await getInventoryRow(bookId, locationId);
    return row!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Transfer stock between locations ─────────────────────────────────────────
// Both locations must be in the same branch.
// Uses REPEATABLE READ + FOR UPDATE to prevent concurrent transfers.

export async function transferStock(opts: {
  bookId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  fromVersion: number;
  staffCtx: StaffCtx;
}): Promise<{ from: InventoryRow; to: InventoryRow }> {
  const { bookId, fromLocationId, toLocationId, quantity, fromVersion, staffCtx } = opts;

  if (quantity <= 0) throw new ValidationError('Transfer quantity must be positive');
  if (fromLocationId === toLocationId) throw new ValidationError('Source and destination locations must differ');

  // Verify both locations belong to the same branch
  const locCheck = await db.query(
    `SELECT id, branch_id FROM locations WHERE id = ANY($1)`,
    [[fromLocationId, toLocationId]],
  );
  if (locCheck.rows.length !== 2) throw new NotFoundError('One or both locations');
  const branchIds = locCheck.rows.map((r: { branch_id: number }) => r.branch_id);
  if (branchIds[0] !== branchIds[1]) {
    throw new ValidationError('Cannot transfer stock between locations in different branches');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    // Lock source row first (lower id first to avoid deadlock)
    const lockOrder = fromLocationId < toLocationId
      ? [fromLocationId, toLocationId]
      : [toLocationId, fromLocationId];

    await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = ANY($2) FOR UPDATE`,
      [bookId, lockOrder],
    );

    // Read source
    const src = await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, fromLocationId],
    );
    if (!src.rows.length) throw new NotFoundError('Source inventory record');

    const srcVersion = src.rows[0].version as number;
    const srcQty = src.rows[0].quantity as number;

    if (srcVersion !== fromVersion) {
      throw new ConflictError('VERSION_CONFLICT', 'Source inventory was modified. Please refresh and retry.', { currentVersion: srcVersion, providedVersion: fromVersion });
    }
    if (srcQty < quantity) {
      throw new BusinessError('INSUFFICIENT_STOCK', `Insufficient stock at source. Available: ${srcQty}, Requested: ${quantity}`);
    }

    // Read destination (initialize if missing)
    await client.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
      [bookId, toLocationId],
    );
    const dst = await client.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, toLocationId],
    );
    const dstQty = dst.rows[0].quantity as number;

    // Apply updates
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

    // History: two rows (out + in)
    await client.query(
      `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, notes, staff_id)
       VALUES ($1, $2, $3, $4, $5, 'transfer_out', 'transfer_out', $6, $7),
              ($1, $8, $9, $10, $11, 'transfer_in', 'transfer_in', $6, $7)`,
      [bookId, fromLocationId, srcQty, srcQty - quantity, -quantity,
       `Transfer to location ${toLocationId}`, staffCtx.staffId,
       toLocationId, dstQty, dstQty + quantity, quantity],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'inventory_transfer', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(bookId), staffCtx.branchId,
       JSON.stringify({ bookId, fromLocationId, toLocationId, quantity })],
    );

    await client.query('COMMIT');

    // Emit notification event (non-blocking)
    try {
      const locRes = await db.query('SELECT id, name, branch_id FROM locations WHERE id = ANY($1)', [[fromLocationId, toLocationId]]);
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

    const [fromRow, toRow] = await Promise.all([
      getInventoryRow(bookId, fromLocationId),
      getInventoryRow(bookId, toLocationId),
    ]);
    return { from: fromRow!, to: toRow! };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Get low-stock items for a branch ─────────────────────────────────────────

export async function getLowStock(branchId: number): Promise<InventoryRow[]> {
  const result = await db.query(
    `SELECT i.book_id, b.title AS book_title, b.isbn AS book_isbn,
            i.location_id, l.name AS location_name, l.branch_id,
            i.quantity, i.reorder_point, i.version, i.updated_at,
            true AS is_low_stock
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
     JOIN books b ON b.id = i.book_id
     WHERE l.branch_id = $1 AND i.quantity <= i.reorder_point
     ORDER BY i.quantity ASC, b.title ASC`,
    [branchId],
  );
  return result.rows.map(mapInventoryRow);
}

// ── Get inventory history ─────────────────────────────────────────────────────

export async function getInventoryHistory(opts: {
  branchId: number;
  bookId?: number;
  locationId?: number;
  reasonCode?: ReasonCode;
  movementType?: MovementType;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: HistoryRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ['l.branch_id = $1'];
  const params: unknown[] = [opts.branchId];
  let p = 2;

  if (opts.bookId) { conditions.push(`ih.book_id = $${p++}`); params.push(opts.bookId); }
  if (opts.locationId) { conditions.push(`ih.location_id = $${p++}`); params.push(opts.locationId); }
  if (opts.movementType) { conditions.push(`ih.movement_type = $${p++}`); params.push(opts.movementType); }
  if (opts.reasonCode) { conditions.push(`ih.reason_code = $${p++}`); params.push(opts.reasonCode); }
  if (opts.dateFrom) { conditions.push(`ih.created_at >= $${p++}`); params.push(opts.dateFrom); }
  if (opts.dateTo) { conditions.push(`ih.created_at <= $${p++}`); params.push(opts.dateTo); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countRes, dataRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FROM inventory_history ih
       JOIN locations l ON l.id = ih.location_id ${where}`,
      params,
    ),
    db.query(
      `SELECT ih.id, ih.book_id, b.title AS book_title,
              ih.location_id, l.name AS location_name,
              ih.qty_before, ih.qty_after, ih.delta,
              ih.movement_type, ih.reason_code,
              ih.reference_type, ih.reference_id,
              ih.notes,
              ih.staff_id, s.username AS staff_username,
              ih.created_at
       FROM inventory_history ih
       JOIN locations l ON l.id = ih.location_id
       JOIN books b ON b.id = ih.book_id
       JOIN staff s ON s.id = ih.staff_id
       ${where}
       ORDER BY ih.created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, pageSize, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(mapHistoryRow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── Update reorder point ──────────────────────────────────────────────────────

export async function setReorderPoint(
  bookId: number,
  locationId: number,
  reorderPoint: number,
  staffCtx: StaffCtx,
): Promise<InventoryRow> {
  if (reorderPoint < 0) throw new ValidationError('Reorder point cannot be negative');

  const result = await db.query(
    `UPDATE inventory SET reorder_point = $1, updated_at = now()
     WHERE book_id = $2 AND location_id = $3
     RETURNING *`,
    [reorderPoint, bookId, locationId],
  );
  if (!result.rows.length) throw new NotFoundError('Inventory record');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'inventory_reorder', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, `${bookId}:${locationId}`, staffCtx.branchId,
     JSON.stringify({ bookId, locationId, reorderPoint })],
  );

  return (await getInventoryRow(bookId, locationId))!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getInventoryRow(bookId: number, locationId: number): Promise<InventoryRow | null> {
  const result = await db.query(
    `SELECT i.book_id, b.title AS book_title, b.isbn AS book_isbn,
            i.location_id, l.name AS location_name, l.branch_id,
            i.quantity, i.reorder_point, i.version, i.updated_at,
            (i.quantity <= i.reorder_point) AS is_low_stock
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
     JOIN books b ON b.id = i.book_id
     WHERE i.book_id = $1 AND i.location_id = $2`,
    [bookId, locationId],
  );
  if (!result.rows.length) return null;
  return mapInventoryRow(result.rows[0]);
}

function mapInventoryRow(row: Record<string, unknown>): InventoryRow {
  return {
    bookId: row.book_id as number,
    bookTitle: row.book_title as string,
    bookIsbn: row.book_isbn as string,
    locationId: row.location_id as number,
    locationName: row.location_name as string,
    branchId: row.branch_id as number,
    quantity: row.quantity as number,
    reorderPoint: row.reorder_point as number,
    version: row.version as number,
    isLowStock: row.is_low_stock as boolean,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapHistoryRow(row: Record<string, unknown>): HistoryRow {
  return {
    id: String(row.id),
    bookId: row.book_id as number,
    bookTitle: row.book_title as string,
    locationId: row.location_id as number,
    locationName: row.location_name as string,
    qtyBefore: row.qty_before as number,
    qtyAfter: row.qty_after as number,
    delta: row.delta as number,
    movementType: (row.movement_type as MovementType) ?? 'adjustment',
    reasonCode: row.reason_code as ReasonCode,
    referenceType: (row.reference_type as string | null) ?? null,
    referenceId: row.reference_id != null ? String(row.reference_id) : null,
    notes: (row.notes as string | null) ?? null,
    staffId: row.staff_id as number,
    staffUsername: row.staff_username as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Stock In ──────────────────────────────────────────────────────────────────
// Business-driven incoming inventory (procurement receipts, returns, etc.)
// Always increases stock. Separate from adjust() which is for corrections only.

export async function stockIn(opts: {
  bookId: number;
  locationId: number;
  quantity: number;
  version: number;
  referenceType?: ReferenceType;
  referenceId?: number;
  notes?: string;
  staffCtx: StaffCtx;
}): Promise<InventoryRow> {
  const { bookId, locationId, quantity, version, referenceId, notes, staffCtx } = opts;
  const referenceType: ReferenceType = opts.referenceType ?? 'manual';

  if (quantity <= 0) throw new ValidationError('Stock-in quantity must be positive');

  // Validate: purchase_order reference_type requires a reference_id
  if (referenceType === 'purchase_order' && !referenceId) {
    throw new ValidationError('reference_id is required when reference_type is purchase_order');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Initialize row if missing (idempotent)
    await client.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
      [bookId, locationId],
    );

    const current = await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
      [bookId, locationId],
    );
    if (!current.rows.length) throw new NotFoundError('Inventory record');

    const currentVersion = current.rows[0].version as number;
    const currentQty = current.rows[0].quantity as number;

    if (currentVersion !== version) {
      throw new ConflictError('VERSION_CONFLICT', 'Inventory was modified. Please refresh and retry.', { currentVersion, providedVersion: version });
    }

    const newQty = currentQty + quantity;

    const updated = await client.query(
      `UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3 AND version = $4
       RETURNING quantity, version`,
      [newQty, bookId, locationId, version],
    );
    if (!updated.rows.length) {
      throw new ConflictError('VERSION_CONFLICT', 'Concurrent modification detected. Please retry.');
    }

    await client.query(
      `INSERT INTO inventory_history
         (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
       VALUES ($1, $2, $3, $4, $5, 'stock_in', 'stock_in', $6, $7, $8, $9)`,
      [bookId, locationId, currentQty, newQty, quantity,
       referenceType ?? null, referenceId ?? null, notes ?? null, staffCtx.staffId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'inventory_stock_in', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, `${bookId}:${locationId}`, staffCtx.branchId,
       JSON.stringify({ bookId, locationId, quantity, referenceType, referenceId, qtyBefore: currentQty, qtyAfter: newQty })],
    );

    await client.query('COMMIT');

    // Emit notification event (non-blocking)
    try {
      const locRes = await db.query('SELECT name, branch_id FROM locations WHERE id = $1', [locationId]);
      const locationName = locRes.rows[0]?.name ?? String(locationId);
      const branchIdForNotif = locRes.rows[0]?.branch_id ?? staffCtx.branchId;
      const bookRes = await db.query('SELECT title FROM books WHERE id = $1', [bookId]);
      const bookTitle = bookRes.rows[0]?.title ?? String(bookId);
      const notifClient = await db.connect();
      try {
        await notifClient.query('BEGIN');
        await insertOutbox(notifClient, 'inventory.stock_in', {
          bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity,
        });
        // Check low-stock threshold
        if (newQty === 0) {
          await insertOutbox(notifClient, 'inventory.out_of_stock', { bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity: newQty });
        }
        await notifClient.query('COMMIT');
      } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
    } catch { /* non-fatal */ }

    return (await getInventoryRow(bookId, locationId))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Stock Out ─────────────────────────────────────────────────────────────────
// Business-driven outgoing inventory (sales, orders, etc.)
// Decreases stock. Enforces negative-stock policy.

export async function stockOut(opts: {
  bookId: number;
  locationId: number;
  quantity: number;
  version: number;
  referenceType?: string;
  referenceId?: number;
  notes?: string;
  staffCtx: StaffCtx;
}): Promise<InventoryRow> {
  const { bookId, locationId, quantity, version, referenceType, referenceId, notes, staffCtx } = opts;

  if (quantity <= 0) throw new ValidationError('Stock-out quantity must be positive');

  // Pre-check negative stock policy
  const allowNeg = await isNegativeStockAllowed();
  if (!allowNeg) {
    const check = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    );
    if (!check.rows.length) throw new NotFoundError('Inventory record');
    const available = check.rows[0].quantity as number;
    if (available < quantity) {
      throw new BusinessError('INSUFFICIENT_STOCK', `Insufficient stock. Available: ${available}, Requested: ${quantity}`);
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
      [bookId, locationId],
    );
    if (!current.rows.length) throw new NotFoundError('Inventory record');

    const currentVersion = current.rows[0].version as number;
    const currentQty = current.rows[0].quantity as number;

    if (currentVersion !== version) {
      throw new ConflictError('VERSION_CONFLICT', 'Inventory was modified. Please refresh and retry.', { currentVersion, providedVersion: version });
    }

    const newQty = currentQty - quantity;
    if (newQty < 0 && !allowNeg) {
      throw new BusinessError('INSUFFICIENT_STOCK', `Insufficient stock. Available: ${currentQty}, Requested: ${quantity}`);
    }

    const updated = await client.query(
      `UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now()
       WHERE book_id = $2 AND location_id = $3 AND version = $4
       RETURNING quantity, version`,
      [newQty, bookId, locationId, version],
    );
    if (!updated.rows.length) {
      throw new ConflictError('VERSION_CONFLICT', 'Concurrent modification detected. Please retry.');
    }

    await client.query(
      `INSERT INTO inventory_history
         (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
       VALUES ($1, $2, $3, $4, $5, 'stock_out', 'stock_out', $6, $7, $8, $9)`,
      [bookId, locationId, currentQty, newQty, -quantity,
       referenceType ?? null, referenceId ?? null, notes ?? null, staffCtx.staffId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'inventory_stock_out', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, `${bookId}:${locationId}`, staffCtx.branchId,
       JSON.stringify({ bookId, locationId, quantity, referenceType, referenceId, qtyBefore: currentQty, qtyAfter: newQty })],
    );

    await client.query('COMMIT');

    // Emit notification event (non-blocking)
    try {
      const locRes = await db.query('SELECT name, branch_id FROM locations WHERE id = $1', [locationId]);
      const locationName = locRes.rows[0]?.name ?? String(locationId);
      const branchIdForNotif = locRes.rows[0]?.branch_id ?? staffCtx.branchId;
      const bookRes = await db.query('SELECT title FROM books WHERE id = $1', [bookId]);
      const bookTitle = bookRes.rows[0]?.title ?? String(bookId);
      const notifClient = await db.connect();
      try {
        await notifClient.query('BEGIN');
        await insertOutbox(notifClient, 'inventory.stock_out', {
          bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity, reasonCode: referenceType ?? 'manual',
        });
        if (newQty === 0) {
          await insertOutbox(notifClient, 'inventory.out_of_stock', { bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity: newQty });
        } else {
          const rpRes = await notifClient.query('SELECT reorder_point FROM inventory WHERE book_id = $1 AND location_id = $2', [bookId, locationId]);
          const rp = rpRes.rows[0]?.reorder_point as number ?? 5;
          if (newQty <= rp) {
            await insertOutbox(notifClient, 'inventory.low_stock', { bookId, bookTitle, locationId, locationName, branchId: branchIdForNotif, quantity: newQty, reorderPoint: rp });
          }
        }
        await notifClient.query('COMMIT');
      } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
    } catch { /* non-fatal */ }

    return (await getInventoryRow(bookId, locationId))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Inventory Reservation Helpers ────────────────────────────────────────────
// Used by the order lifecycle to soft-reserve stock on confirmation.

/**
 * Compute available stock = inventory.quantity - SUM(active reservations).
 * Falls back to raw inventory quantity if inventory_reservations doesn't exist yet.
 */
export async function getAvailableStock(bookId: number, locationId: number): Promise<number> {
  if (await hasReservationsTable()) {
    const result = await db.query(
      `SELECT i.quantity - COALESCE(SUM(r.quantity), 0) AS available
       FROM inventory i
       LEFT JOIN inventory_reservations r
         ON r.book_id = i.book_id
         AND r.location_id = i.location_id
         AND r.status = 'reserved'
       WHERE i.book_id = $1 AND i.location_id = $2
       GROUP BY i.quantity`,
      [bookId, locationId],
    );
    if (!result.rows.length) return 0;
    return Math.max(0, parseFloat(result.rows[0].available as string));
  }
  // Fallback: no reservations table yet — return raw quantity
  const result = await db.query(
    `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  if (!result.rows.length) return 0;
  return Math.max(0, parseInt(result.rows[0].quantity as string, 10));
}

/**
 * Create a reservation for an order line item.
 * No-op if inventory_reservations table doesn't exist yet.
 */
export async function createReservation(
  orderId: number | string,
  bookId: number,
  locationId: number,
  quantity: number,
): Promise<void> {
  if (!(await hasReservationsTable())) return;
  await db.query(
    `INSERT INTO inventory_reservations (order_id, book_id, location_id, quantity, status)
     VALUES ($1, $2, $3, $4, 'reserved')`,
    [orderId, bookId, locationId, quantity],
  );
}

/**
 * Release all reserved (not yet deducted) reservations for an order.
 * Called when an order is cancelled from CONFIRMED status.
 * No-op if inventory_reservations table doesn't exist yet.
 */
export async function releaseReservations(orderId: number | string): Promise<void> {
  if (!(await hasReservationsTable())) return;
  await db.query(
    `UPDATE inventory_reservations
     SET status = 'released', updated_at = now()
     WHERE order_id = $1 AND status = 'reserved'`,
    [orderId],
  );
}

/**
 * Convert reserved → deducted for an order (called on fulfilment).
 * No-op if inventory_reservations table doesn't exist yet.
 */
export async function deductReservations(orderId: number | string): Promise<void> {
  if (!(await hasReservationsTable())) return;
  await db.query(
    `UPDATE inventory_reservations
     SET status = 'deducted', updated_at = now()
     WHERE order_id = $1 AND status = 'reserved'`,
    [orderId],
  );
}
