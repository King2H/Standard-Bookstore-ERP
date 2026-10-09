/** The signed-in staff member reading their notifications. */
export interface Recipient {
  staffId: number;
  role: string;
  /** The session branch. */
  branchId: number;
  /** Access to all branches (staff.is_all_branches). */
  allBranches: boolean;
}

/** A notifications row in application form. */
export interface NotificationRecord {
  id: string;
  branchId: number | null;
  targetRoles: string[];
  targetStaffId: number | null;
  eventType: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  severity: string;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface NewNotification {
  branchId: number | null;
  targetRoles: string[];
  eventType: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  severity: string;
}
