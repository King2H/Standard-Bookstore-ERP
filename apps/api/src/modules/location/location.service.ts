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

    // Dependency check: inventory (table added in Slice 7 — guard with existence check)
    const inventoryTableExists = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'inventory'`,
    );
    if (inventoryTableExists.rows.length > 0) {
      const inventoryCheck = await client.query(
        `SELECT COUNT(*) FROM inventory WHERE location_id = $1 AND quantity > 0`,
        [id],
      );
      if (parseInt(inventoryCheck.rows[0].count, 10) > 0) {
        throw new ConflictError('DEPENDENCY_CONFLICT', 'Cannot delete location: inventory items exist', {
          blockingDependencies: [{ type: 'inventory', count: parseInt(inventoryCheck.rows[0].count, 10) }],
        });
      }
    }

    // Dependency check: open orders (table added in Slice 13 — guard with existence check)
    const ordersTableExists = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'orders'`,
    );
    if (ordersTableExists.rows.length > 0) {
      const ordersCheck = await client.query(
        `SELECT COUNT(*) FROM orders
         WHERE location_id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [id],
      );
      if (parseInt(ordersCheck.rows[0].count, 10) > 0) {
        throw new ConflictError('DEPENDENCY_CONFLICT', 'Cannot delete location: open orders exist', {
          blockingDependencies: [{ type: 'orders', count: parseInt(ordersCheck.rows[0].count, 10) }],
        });
      }
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
