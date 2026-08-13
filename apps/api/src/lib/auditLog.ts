import { db } from '../db/index.js';

/**
 * Shared audit_logs insert helper (Prompt 3 — Master Data Lifecycle).
 *
 * Before this, every module hand-rolled its own inline
 * `INSERT INTO audit_logs (...)`, which drifted into two incompatible
 * conventions: some wrote literal actions like 'DEACTIVATE'/'REACTIVATE'
 * (branch.service.ts, bankAccount.service.ts), others wrote 'UPDATE' with
 * the real action stashed in `meta.action` (catalog/supplier/customer
 * services). This helper doesn't retrofit that existing code — it's the
 * single insert path for the new lifecycle actions this task adds, so at
 * least those are consistent going forward.
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
  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [staffCtx.staffId, staffCtx.role, action, entityType, String(entityId), staffCtx.branchId, JSON.stringify(meta)],
  );
}
