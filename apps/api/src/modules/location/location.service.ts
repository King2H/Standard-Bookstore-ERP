import { db } from '../../db/index.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Location {
  id: number;
  branchId: number;
  name: string;
  isDefaultFulfillment: boolean;
  createdAt: string;
}

export interface StaffCtx {
  staffId: number;
  role: string;
  branchId: number;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): Location {
  return {
    id: row.id as number,
    branchId: row.branch_id as number,
    name: row.name as string,
    isDefaultFulfillment: row.is_default_fulfillment as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listLocations(branchId: number): Promise<Location[]> {
  const result = await db.query(
    `SELECT id, branch_id, name, is_default_fulfillment, created_at
     FROM locations
     WHERE branch_id = $1
     ORDER BY is_default_fulfillment DESC, name ASC`,
    [branchId],
  );
  return result.rows.map(mapRow);
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createLocation(
  branchId: number,
  name: string,
  staffCtx: StaffCtx,
): Promise<Location> {
  // Validate branch is active
  const branchCheck = await db.query(
    `SELECT id FROM branches WHERE id = $1 AND is_active = true`,
    [branchId],
  );
  if (branchCheck.rows.length === 0) {
    throw new NotFoundError('Branch');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let result;
    try {
      result = await client.query(
        `INSERT INTO locations (branch_id, name, is_default_fulfillment)
         VALUES ($1, $2, false)
         RETURNING id, branch_id, name, is_default_fulfillment, created_at`,
        [branchId, name],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('DUPLICATE_LOCATION_NAME', `Location '${name}' already exists in this branch`);
      }
      throw err;
    }

    const location = mapRow(result.rows[0]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'location', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(location.id),
        branchId,
        JSON.stringify({ name }),
      ],
    );

    await client.query('COMMIT');
    return location;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Rename ────────────────────────────────────────────────────────────────────

export async function renameLocation(
  id: number,
  name: string,
  staffCtx: StaffCtx,
): Promise<Location> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, branch_id, name FROM locations WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Location');

    const branchId: number = existing.rows[0].branch_id;
    const oldName: string = existing.rows[0].name;

    let result;
    try {
      result = await client.query(
        `UPDATE locations SET name = $1 WHERE id = $2
         RETURNING id, branch_id, name, is_default_fulfillment, created_at`,
        [name, id],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('DUPLICATE_LOCATION_NAME', `Location '${name}' already exists in this branch`);
      }
      throw err;
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'location', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(id),
        branchId,
        JSON.stringify({ oldName, newName: name }),
      ],
    );

    await client.query('COMMIT');
    return mapRow(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Set Default ───────────────────────────────────────────────────────────────
// Atomically clears all defaults for the branch, then sets the target as default.
// The partial unique index enforces at most one default at the DB level.

export async function setDefaultLocation(id: number, staffCtx: StaffCtx): Promise<Location> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, branch_id FROM locations WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Location');

    const branchId: number = existing.rows[0].branch_id;

    // Clear all defaults for this branch first
    await client.query(
      `UPDATE locations SET is_default_fulfillment = false WHERE branch_id = $1`,
      [branchId],
    );

    // Set the target as default
    const result = await client.query(
      `UPDATE locations SET is_default_fulfillment = true WHERE id = $1
       RETURNING id, branch_id, name, is_default_fulfillment, created_at`,
      [id],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'location', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(id),
        branchId,
        JSON.stringify({ action: 'set_default' }),
      ],
    );

    await client.query('COMMIT');
    return mapRow(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteLocation(id: number, staffCtx: StaffCtx): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, branch_id, name FROM locations WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Location');

    const branchId: number = existing.rows[0].branch_id;
    const name: string = existing.rows[0].name;

    // Dependency check: inventory
    const inventoryCheck = await client.query(
      `SELECT COUNT(*) FROM inventory WHERE location_id = $1 AND quantity > 0`,
      [id],
    );
    if (parseInt(inventoryCheck.rows[0].count, 10) > 0) {
      throw new ConflictError('DEPENDENCY_CONFLICT', 'Cannot delete location: inventory items exist', {
        blockingDependencies: [{ type: 'inventory', count: parseInt(inventoryCheck.rows[0].count, 10) }],
      });
    }

    // Dependency check: history. These tables reference the location without
    // ON DELETE, so the database refuses the delete while any such row exists,
    // whatever its status. Report them as a 409 instead of failing with a 500.
    const history = await client.query(
      `SELECT type, count FROM (VALUES
         ('orders',            (SELECT COUNT(*) FROM orders WHERE location_id = $1)),
         ('pos_transactions',  (SELECT COUNT(*) FROM transactions WHERE location_id = $1)),
         ('exchanges',         (SELECT COUNT(*) FROM exchanges WHERE location_id = $1)),
         ('purchase_orders',   (SELECT COUNT(*) FROM purchase_orders WHERE receiving_location_id = $1)),
         ('po_receipts',       (SELECT COUNT(*) FROM po_receipts WHERE location_id = $1)),
         ('inventory_history', (SELECT COUNT(*) FROM inventory_history WHERE location_id = $1)),
         ('reservations',      (SELECT COUNT(*) FROM inventory_reservations WHERE location_id = $1))
       ) AS h(type, count)
       WHERE count > 0`,
      [id],
    );
    if (history.rows.length > 0) {
      throw new ConflictError('DEPENDENCY_CONFLICT', 'Cannot delete location: it has transaction history', {
        blockingDependencies: history.rows.map((r: { type: string; count: string }) => ({
          type: r.type,
          count: parseInt(r.count, 10),
        })),
      });
    }

    await client.query(`DELETE FROM locations WHERE id = $1`, [id]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'DELETE', 'location', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(id),
        branchId,
        JSON.stringify({ name }),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
