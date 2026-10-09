import { kysely } from '../db/kysely.js';
import { insertAuditEntry } from '../modules/audit/audit.repository.js';

/**
 * Shared audit_logs insert helper (Prompt 3 — Master Data Lifecycle), for
 * modules not yet moved to the layered structure. It writes outside the
 * caller's transaction; migrated modules call insertAuditEntry with their
 * `tx` instead, so the entry commits exactly with the change (#21).
 */

export type LifecycleAction = 'ACTIVATE' | 'INACTIVATE' | 'ARCHIVE' | 'RESTORE' | 'DELETE';

export interface AuditLogStaffCtx {
  staffId: number;
  role: string;
  branchId: number;
}

export async function insertAuditLog(
  staffCtx: AuditLogStaffCtx,
  action: LifecycleAction | string,
  entityType: string,
  entityId: string | number,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await insertAuditEntry(kysely, {
    staffId: staffCtx.staffId,
    staffRole: staffCtx.role,
    branchId: staffCtx.branchId,
    action,
    entityType,
    entityId,
    meta,
  });
}
