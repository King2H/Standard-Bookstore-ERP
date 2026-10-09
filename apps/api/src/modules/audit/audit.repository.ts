import type { Queryable } from '../../db/tx.js';

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
