/** An audit_logs row in application form, with the staff member's and branch's names. */
export interface AuditLogRecord {
  id: string;
  staffId: number | null;
  staffUsername: string | null;
  staffRole: string | null;
  action: string;
  entityType: string;
  entityId: string;
  branchId: number | null;
  branchName: string | null;
  meta: unknown;
  createdAt: Date;
}

export interface AuditLogFilter {
  /** Undefined: every branch, and the entries that belong to no branch. */
  branchId?: number;
  entityType?: string;
  staffId?: number;
}
