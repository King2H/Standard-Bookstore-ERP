import type { LocationAccessMode } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './location.policy.js';
import * as locations from './location.repository.js';
import type { Actor, LocationRecord, StaffLocationRecord } from './location.types.js';

/** Use cases of the Locations module (A4): one function each, owning its transaction. */

type Staff = Pick<Actor, 'staffId' | 'role' | 'branchId'>;

function audit(q: Queryable, actor: Staff, action: string, entityType: string, entityId: number, branchId: number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, { staffId: actor.staffId, staffRole: actor.role, branchId, action, entityType, entityId, meta });
}

async function getOrThrow(q: Queryable, branchId: number, id: number): Promise<LocationRecord> {
  const location = await locations.findInBranch(q, branchId, id);
  if (!location) throw new NotFoundError('Location');
  return location;
}

function duplicateName(err: unknown, name: string): never {
  if (isUniqueViolation(err)) {
    throw new ConflictError('DUPLICATE_LOCATION_NAME', `Location '${name}' already exists in this branch`);
  }
  throw err;
}

// ── A branch's locations ──────────────────────────────────────────────────────

/**
 * The branch's locations as the actor may use them: all of them for roles that
 * manage locations and for staff without assignments; otherwise only the
 * assigned ones.
 */
export async function listLocations(
  actor: Staff,
  branchId: number,
): Promise<{ items: LocationRecord[]; accessMode: LocationAccessMode }> {
  if (!policy.hasFullLocationAccess(actor.role)) {
    const assigned = await locations.listAssignedInBranch(kysely, actor.staffId, branchId);
    if (assigned.length > 0) return { items: assigned, accessMode: 'restricted' };
  }
  return { items: await locations.listByBranch(kysely, branchId), accessMode: 'full' };
}

export async function createLocation(actor: Staff, branchId: number, name: string): Promise<LocationRecord> {
  if (!(await locations.isBranchActive(kysely, branchId))) throw new NotFoundError('Branch');

  return withTransaction({}, async (tx) => {
    const location = await locations.insert(tx, branchId, name).catch((err) => duplicateName(err, name));
    await audit(tx, actor, 'CREATE', 'location', location.id, branchId, { name });
    return location;
  });
}

export async function renameLocation(actor: Staff, branchId: number, id: number, name: string): Promise<LocationRecord> {
  return withTransaction({}, async (tx) => {
    const existing = await getOrThrow(tx, branchId, id);
    const location = await locations.rename(tx, branchId, id, name).catch((err) => duplicateName(err, name));
    await audit(tx, actor, 'UPDATE', 'location', id, branchId, { oldName: existing.name, newName: name });
    return location;
  });
}

export async function setDefaultLocation(actor: Staff, branchId: number, id: number): Promise<LocationRecord> {
  return withTransaction({}, async (tx) => {
    await getOrThrow(tx, branchId, id);
    const location = await locations.makeDefault(tx, branchId, id);
    await audit(tx, actor, 'UPDATE', 'location', id, branchId, { action: 'set_default' });
    return location;
  });
}

export async function deleteLocation(actor: Staff, branchId: number, id: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    const existing = await getOrThrow(tx, branchId, id);
    policy.checkDeletable(await locations.countStockLines(tx, id), await locations.historyOf(tx, id));
    await locations.remove(tx, branchId, id);
    await audit(tx, actor, 'DELETE', 'location', id, branchId, { name: existing.name });
  });
}

// ── Staff location restrictions ───────────────────────────────────────────────

/** Locations the staff member may use in their session branch: their assigned ones, or all when they have none. */
export async function getAccessibleLocations(staff: Staff): Promise<LocationRecord[]> {
  const assigned = await locations.listAssignedInBranch(kysely, staff.staffId, staff.branchId);
  return assigned.length > 0 ? assigned : locations.listByBranch(kysely, staff.branchId);
}

/**
 * Throws unless the staff member may use the location: it must be in their
 * session branch (403) and pass assertAssignedLocation.
 */
export async function assertLocationAccess(locationId: number, staff: Staff): Promise<void> {
  const branchId = (await locations.branchesOf(kysely, [locationId])).get(locationId);
  if (branchId === undefined) throw new NotFoundError('Location');
  if (branchId !== staff.branchId) throw new ForbiddenError('Location does not belong to your current branch');
  await assertAssignedLocation(locationId, staff);
}

/**
 * Staff with location assignments in their session branch may book stock and
 * sales only at those locations (#72). Roles that manage locations are never
 * limited. Null means the branch's default location.
 */
export async function assertAssignedLocation(locationId: number | null, staff: Staff): Promise<void> {
  if (policy.hasFullLocationAccess(staff.role)) return;
  const assigned = await locations.listAssignedInBranch(kysely, staff.staffId, staff.branchId);
  if (assigned.length === 0) return;
  const id = locationId ?? (await locations.findDefaultId(kysely, staff.branchId));
  if (id === undefined || !assigned.some((l) => l.id === id)) {
    throw new ForbiddenError('You do not have access to this location');
  }
}

/** The staff member's assignments in every branch; empty means no restrictions. */
export async function getStaffLocations(actor: Actor, staffId: number): Promise<StaffLocationRecord[]> {
  policy.checkCanManageStaff(actor, await locations.staffBranches(kysely, staffId));
  return locations.listAssignments(kysely, staffId);
}

/**
 * Replaces the staff member's assignments in the branches the actor manages;
 * `[]` lifts them. Other branches' assignments must be sent back unchanged.
 */
export async function setStaffLocations(actor: Actor, staffId: number, locationIds: number[]): Promise<void> {
  const targetBranches = await locations.staffBranches(kysely, staffId);
  policy.checkCanManageStaff(actor, targetBranches);

  await withTransaction({}, async (tx) => {
    const current = await locations.listAssignments(tx, staffId);
    const locationBranch = await locations.branchesOf(tx, locationIds);
    policy.checkStaffLocationChange(actor, locationIds, locationBranch, targetBranches, current);

    await locations.replaceAssignments(tx, staffId, policy.manageableBranches(actor), locationIds);
    await audit(tx, actor, 'UPDATE', 'staff_locations', staffId, actor.branchId, {
      action: locationIds.length === 0 ? 'clear_location_restrictions' : 'set_location_restrictions',
      locationIds,
    });
  });
}
