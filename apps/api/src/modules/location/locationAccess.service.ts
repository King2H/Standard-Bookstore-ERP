import { db } from '../../db/index.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { Location, StaffCtx } from './location.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocationAccessEntry {
  locationId: number;
  locationName: string;
  branchId: number;
}

// ── getAccessibleLocations ────────────────────────────────────────────────────
// Returns the locations this staff member may access in their current branch.
// Fallback: if no explicit assignments exist → all branch locations.

export async function getAccessibleLocations(staffCtx: StaffCtx): Promise<Location[]> {
  // Check if staff has any explicit location assignments for this branch
  const assigned = await db.query(
    `SELECT l.id, l.branch_id, l.name, l.is_default_fulfillment, l.created_at
     FROM staff_locations sl
     JOIN locations l ON l.id = sl.location_id
     WHERE sl.staff_id = $1 AND l.branch_id = $2
     ORDER BY l.is_default_fulfillment DESC, l.name ASC`,
    [staffCtx.staffId, staffCtx.branchId],
  );

  if (assigned.rows.length > 0) {
    return assigned.rows.map(mapRow);
  }

  // Fallback: return all locations in the branch
  const all = await db.query(
    `SELECT id, branch_id, name, is_default_fulfillment, created_at
     FROM locations
     WHERE branch_id = $1
     ORDER BY is_default_fulfillment DESC, name ASC`,
    [staffCtx.branchId],
  );
  return all.rows.map(mapRow);
}

// ── assertLocationAccess ──────────────────────────────────────────────────────
// Throws 403 if the staff member cannot access the given location.
// Rules:
//   1. Location must belong to staff's current branch.
//   2. If staff has explicit location assignments → location must be in that set.
//   3. If staff has NO assignments → any location in the branch is allowed.

export async function assertLocationAccess(locationId: number, staffCtx: StaffCtx): Promise<void> {
  // Verify location exists and belongs to staff's branch
  const locResult = await db.query(
    `SELECT id, branch_id FROM locations WHERE id = $1`,
    [locationId],
  );
  if (locResult.rows.length === 0) {
    throw new NotFoundError('Location');
  }
  if (locResult.rows[0].branch_id !== staffCtx.branchId) {
    throw new ForbiddenError('Location does not belong to your current branch');
  }

  // Check if staff has explicit location restrictions
  const assignedCount = await db.query(
    `SELECT COUNT(*) FROM staff_locations sl
     JOIN locations l ON l.id = sl.location_id
     WHERE sl.staff_id = $1 AND l.branch_id = $2`,
    [staffCtx.staffId, staffCtx.branchId],
  );

  const hasRestrictions = parseInt(assignedCount.rows[0].count, 10) > 0;
  if (!hasRestrictions) {
    // Fallback mode — access all branch locations
    return;
  }

  // Restricted mode — check membership
  const membership = await db.query(
    `SELECT 1 FROM staff_locations WHERE staff_id = $1 AND location_id = $2`,
    [staffCtx.staffId, locationId],
  );
  if (membership.rows.length === 0) {
    throw new ForbiddenError('You do not have access to this location');
  }
}

// ── assignLocationsToStaff ────────────────────────────────────────────────────
// Full replace: removes all existing assignments for this staff+branch,
// then inserts the new set. Passing an empty array clears restrictions
// (restores fallback / full-branch-access mode).

export async function assignLocationsToStaff(
  targetStaffId: number,
  locationIds: number[],
  staffCtx: StaffCtx,
): Promise<void> {
  // Validate all provided locations belong to a branch the target staff is assigned to
  if (locationIds.length > 0) {
    const validCheck = await db.query(
      `SELECT l.id FROM locations l
       JOIN staff_branch_roles sbr ON sbr.branch_id = l.branch_id
       WHERE l.id = ANY($1::int[]) AND sbr.staff_id = $2`,
      [locationIds, targetStaffId],
    );
    if (validCheck.rows.length !== locationIds.length) {
      throw new ForbiddenError('One or more locations do not belong to the staff member\'s assigned branches');
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Remove all existing location assignments for this staff member
    await client.query(
      `DELETE FROM staff_locations WHERE staff_id = $1`,
      [targetStaffId],
    );

    // Insert new assignments
    for (const locationId of locationIds) {
      await client.query(
        `INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`,
        [targetStaffId, locationId],
      );
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'staff_locations', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(targetStaffId),
        staffCtx.branchId,
        JSON.stringify({
          action: locationIds.length === 0 ? 'clear_location_restrictions' : 'set_location_restrictions',
          locationIds,
        }),
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

// ── getStaffLocationAssignments ───────────────────────────────────────────────
// Returns the explicit location assignments for a staff member (empty = fallback mode).

export async function getStaffLocationAssignments(staffId: number): Promise<LocationAccessEntry[]> {
  const result = await db.query(
    `SELECT sl.location_id, l.name AS location_name, l.branch_id
     FROM staff_locations sl
     JOIN locations l ON l.id = sl.location_id
     WHERE sl.staff_id = $1
     ORDER BY l.branch_id, l.name ASC`,
    [staffId],
  );
  return result.rows.map(r => ({
    locationId: r.location_id as number,
    locationName: r.location_name as string,
    branchId: r.branch_id as number,
  }));
}

// ── Row mapper (mirrors location.service.ts) ──────────────────────────────────

function mapRow(row: Record<string, unknown>): Location {
  return {
    id: row.id as number,
    branchId: row.branch_id as number,
    name: row.name as string,
    isDefaultFulfillment: row.is_default_fulfillment as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
