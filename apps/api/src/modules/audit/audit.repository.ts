import type { Queryable } from '../../db/tx.js';
import type { AuditLogFilter, AuditLogRecord } from './audit.types.js';

export interface AuditEntry {
  staffId: number;
  staffRole: string;
  /** Null for changes that belong to no branch, such as system settings. */
  branchId: number | null;
  /** CREATE, UPDATE, DELETE or a lifecycle action such as ARCHIVE. */
  action: string;
  entityType: string;
  entityId: string | number;
  meta?: Record<string, unknown>;
}

/**
 * Records a change in audit_logs. Call it with the same `tx` as the change,
 * so the entry is written exactly when the change commits.
 */
export async function insertAuditEntry(q: Queryable, entry: AuditEntry): Promise<void> {
  await q
    .insertInto('audit_logs')
    .values({
      staff_id: entry.staffId,
      staff_role: entry.staffRole,
      branch_id: entry.branchId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: String(entry.entityId),
      meta: JSON.stringify(entry.meta ?? {}),
    })
    .execute();
}

/** Audit entries, newest first, with the staff member's username and the branch's name. */
export async function list(
  q: Queryable,
  filter: AuditLogFilter,
  page: { limit: number; offset: number },
): Promise<{ items: AuditLogRecord[]; total: number }> {
  let query = q.selectFrom('audit_logs as al');
  if (filter.branchId !== undefined) query = query.where('al.branch_id', '=', filter.branchId);
  if (filter.entityType !== undefined) query = query.where('al.entity_type', '=', filter.entityType);
  if (filter.staffId !== undefined) query = query.where('al.staff_id', '=', filter.staffId);

  const [rows, count] = await Promise.all([
    query
      .leftJoin('staff as s', 's.id', 'al.staff_id')
      .leftJoin('branches as b', 'b.id', 'al.branch_id')
      .select([
        'al.id',
        'al.staff_id',
        's.username as staff_username',
        'al.staff_role',
        'al.action',
        'al.entity_type',
        'al.entity_id',
        'al.branch_id',
        'b.name as branch_name',
        'al.meta',
        'al.created_at',
      ])
      .orderBy('al.created_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      staffId: r.staff_id,
      staffUsername: r.staff_username,
      staffRole: r.staff_role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      branchId: r.branch_id,
      branchName: r.branch_name,
      meta: r.meta,
      createdAt: r.created_at,
    })),
    total: Number(count.count),
  };
}
