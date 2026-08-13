import { db } from '../db/index.js';
import { NotFoundError } from './errors.js';
import { insertAuditLog, type AuditLogStaffCtx, type LifecycleAction } from './auditLog.js';

/**
 * Master Data Lifecycle (Prompt 3) — the unified ACTIVE/INACTIVE/ARCHIVED
 * status model, shared across authors, categories, publishers, books,
 * suppliers, and customers (migration 1700000049 gives all six the
 * identical status/archived_at/archived_by/updated_at/updated_by columns,
 * so one implementation covers all of them instead of six near-duplicate
 * ones — this mirrors the spec's explicit "same pattern for categories,
 * publishers, suppliers, and catalog books" instruction).
 */
export type LifecycleStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

export interface LifecycleTransitionResult {
  id: number;
  status: LifecycleStatus;
  previousStatus: LifecycleStatus;
}

const ACTION_TO_STATUS: Record<'ACTIVATE' | 'INACTIVATE' | 'ARCHIVE' | 'RESTORE', LifecycleStatus> = {
  ACTIVATE: 'ACTIVE',
  INACTIVATE: 'INACTIVE',
  ARCHIVE: 'ARCHIVED',
  RESTORE: 'ACTIVE',
};

/**
 * Applies an ACTIVATE / INACTIVATE / ARCHIVE / RESTORE transition to any
 * of the six lifecycle-managed tables, writes the standardized audit log
 * entry, and returns the before/after status.
 *
 * `syncIsActive`: books and suppliers still carry a legacy `is_active`
 * boolean that dozens of existing consumer-guards (POS/Orders/Exchange/
 * Procurement add-item checks) read directly — keeping it in lockstep
 * (`is_active = status === 'ACTIVE'`) means both INACTIVE and ARCHIVED
 * correctly block those existing checks without having to rewrite every
 * call site to read `status` instead. Authors/categories/publishers/
 * customers have no such legacy flag, so this is a no-op for them.
 */
export async function transitionEntityStatus(
  table: 'authors' | 'categories' | 'publishers' | 'books' | 'suppliers' | 'customers',
  entityType: string,
  id: number,
  action: 'ACTIVATE' | 'INACTIVATE' | 'ARCHIVE' | 'RESTORE',
  staffCtx: AuditLogStaffCtx,
  opts: { syncIsActive?: boolean } = {},
): Promise<LifecycleTransitionResult> {
  const newStatus = ACTION_TO_STATUS[action];

  const current = await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  if (!current.rows.length) throw new NotFoundError(entityType);
  const previousStatus = current.rows[0].status as LifecycleStatus;

  const archivedClause = newStatus === 'ARCHIVED'
    ? `archived_at = now(), archived_by = $2`
    : `archived_at = NULL, archived_by = NULL`;
  const isActiveClause = opts.syncIsActive ? `, is_active = ${newStatus === 'ACTIVE' ? 'true' : 'false'}` : '';

  await db.query(
    `UPDATE ${table} SET status = $3, ${archivedClause}, updated_at = now(), updated_by = $2 ${isActiveClause} WHERE id = $1`,
    [id, staffCtx.staffId, newStatus],
  );

  await insertAuditLog(staffCtx, action as LifecycleAction, entityType, id, { previousStatus, newStatus });

  return { id, status: newStatus, previousStatus };
}

/** Row-count usage check used both by GET .../:id/usage endpoints and by delete-guards. */
export interface UsageQuery { key: string; sql: string }

export async function computeUsage(id: number, queries: UsageQuery[]): Promise<Record<string, number>> {
  const results = await Promise.all(queries.map(q => db.query(q.sql, [id])));
  const usage: Record<string, number> = {};
  queries.forEach((q, i) => { usage[q.key] = parseInt(results[i].rows[0].count as string, 10); });
  return usage;
}

export function totalUsage(usage: Record<string, number>): number {
  return Object.values(usage).reduce((sum, n) => sum + n, 0);
}
