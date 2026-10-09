import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { toLocationRecord } from './location.mapper.js';
import type { LocationDependency, LocationRecord, StaffLocationRecord } from './location.types.js';

// Locations belong to a branch: every query that reads or changes one takes
// the branch, so a location of another branch is simply not found.
// Tenant scope arrives with tenancy (#13).

const COLUMNS = ['l.id', 'l.branch_id', 'l.name', 'l.is_default_fulfillment', 'l.created_at'] as const;
const RETURNING = ['id', 'branch_id', 'name', 'is_default_fulfillment', 'created_at'] as const;
const BRANCH_ORDER = [sql`l.is_default_fulfillment DESC`, sql`l.name ASC`];

export async function listByBranch(q: Queryable, branchId: number): Promise<LocationRecord[]> {
  const rows = await q
    .selectFrom('locations as l')
    .select(COLUMNS)
    .where('l.branch_id', '=', branchId)
    .orderBy(BRANCH_ORDER)
    .execute();
  return rows.map(toLocationRecord);
}

export async function findInBranch(q: Queryable, branchId: number, id: number): Promise<LocationRecord | undefined> {
  const row = await q
    .selectFrom('locations as l')
    .select(COLUMNS)
    .where('l.branch_id', '=', branchId)
    .where('l.id', '=', id)
    .executeTakeFirst();
  return row && toLocationRecord(row);
}

/** The branch each existing location belongs to; unknown ids are left out. */
export async function branchesOf(q: Queryable, ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await q.selectFrom('locations').select(['id', 'branch_id']).where('id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, r.branch_id]));
}

/** Locations are added only to active branches. */
export async function isBranchActive(q: Queryable, branchId: number): Promise<boolean> {
  const row = await q
    .selectFrom('branches')
    .select('id')
    .where('id', '=', branchId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  return row !== undefined;
}

export async function insert(q: Queryable, branchId: number, name: string): Promise<LocationRecord> {
  const row = await q
    .insertInto('locations')
    .values({ branch_id: branchId, name, is_default_fulfillment: false })
    .returning(RETURNING)
    .executeTakeFirstOrThrow();
  return toLocationRecord(row);
}

export async function rename(q: Queryable, branchId: number, id: number, name: string): Promise<LocationRecord> {
  const row = await q
    .updateTable('locations as l')
    .set({ name })
    .where('l.branch_id', '=', branchId)
    .where('l.id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toLocationRecord(row);
}

/**
 * Makes `id` the branch's only default location. The partial unique index
 * allows at most one default per branch, so the others are cleared first.
 */
export async function makeDefault(q: Queryable, branchId: number, id: number): Promise<LocationRecord> {
  await q.updateTable('locations').set({ is_default_fulfillment: false }).where('branch_id', '=', branchId).execute();
  const row = await q
    .updateTable('locations as l')
    .set({ is_default_fulfillment: true })
    .where('l.branch_id', '=', branchId)
    .where('l.id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toLocationRecord(row);
}

export async function remove(q: Queryable, branchId: number, id: number): Promise<void> {
  await q.deleteFrom('locations').where('branch_id', '=', branchId).where('id', '=', id).execute();
}

/** Inventory lines with stock at the location. */
export async function countStockLines(q: Queryable, id: number): Promise<number> {
  const row = await q
    .selectFrom('inventory')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('location_id', '=', id)
    .where('quantity', '>', 0)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Records that reference the location, by kind; kinds with none are left out. */
export async function historyOf(q: Queryable, id: number): Promise<LocationDependency[]> {
  const { rows } = await sql<{ type: string; count: string }>`
    SELECT type, count FROM (VALUES
      ('orders',            (SELECT COUNT(*) FROM orders WHERE location_id = ${id})),
      ('pos_transactions',  (SELECT COUNT(*) FROM transactions WHERE location_id = ${id})),
      ('exchanges',         (SELECT COUNT(*) FROM exchanges WHERE location_id = ${id})),
      ('purchase_orders',   (SELECT COUNT(*) FROM purchase_orders WHERE receiving_location_id = ${id})),
      ('po_receipts',       (SELECT COUNT(*) FROM po_receipts WHERE location_id = ${id})),
      ('inventory_history', (SELECT COUNT(*) FROM inventory_history WHERE location_id = ${id})),
      ('reservations',      (SELECT COUNT(*) FROM inventory_reservations WHERE location_id = ${id}))
    ) AS h(type, count)
    WHERE count > 0`.execute(q);
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}

// ── Staff location restrictions (staff_locations) ────────────────────────────

/** The staff member's assigned locations in one branch. */
export async function listAssignedInBranch(q: Queryable, staffId: number, branchId: number): Promise<LocationRecord[]> {
  const rows = await q
    .selectFrom('staff_locations as sl')
    .innerJoin('locations as l', 'l.id', 'sl.location_id')
    .select(COLUMNS)
    .where('sl.staff_id', '=', staffId)
    .where('l.branch_id', '=', branchId)
    .orderBy(BRANCH_ORDER)
    .execute();
  return rows.map(toLocationRecord);
}

/** The staff member's assigned locations in every branch. */
export async function listAssignments(q: Queryable, staffId: number): Promise<StaffLocationRecord[]> {
  const rows = await q
    .selectFrom('staff_locations as sl')
    .innerJoin('locations as l', 'l.id', 'sl.location_id')
    .select(['sl.location_id', 'l.name', 'l.branch_id'])
    .where('sl.staff_id', '=', staffId)
    .orderBy('l.branch_id')
    .orderBy('l.name')
    .execute();
  return rows.map((r) => ({ locationId: r.location_id, locationName: r.name, branchId: r.branch_id }));
}

export async function isAssigned(q: Queryable, staffId: number, locationId: number): Promise<boolean> {
  const row = await q
    .selectFrom('staff_locations')
    .select('location_id')
    .where('staff_id', '=', staffId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
  return row !== undefined;
}

/** The branches the staff member holds a role in. */
export async function staffBranches(q: Queryable, staffId: number): Promise<number[]> {
  const rows = await q
    .selectFrom('staff_branch_roles')
    .select('branch_id')
    .distinct()
    .where('staff_id', '=', staffId)
    .execute();
  return rows.map((r) => r.branch_id);
}

/**
 * Replaces the staff member's assignments in `branches` (null: every branch)
 * with `locationIds`; assignments in other branches stay as they are.
 */
export async function replaceAssignments(
  q: Queryable,
  staffId: number,
  branches: number[] | null,
  locationIds: number[],
): Promise<void> {
  let del = q.deleteFrom('staff_locations').where('staff_id', '=', staffId);
  if (branches !== null) {
    del = del.where('location_id', 'in', q.selectFrom('locations').select('id').where('branch_id', 'in', branches));
  }
  await del.execute();
  if (locationIds.length > 0) {
    await q
      .insertInto('staff_locations')
      .values(locationIds.map((id) => ({ staff_id: staffId, location_id: id })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
