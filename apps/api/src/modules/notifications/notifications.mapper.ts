import type { Notification } from '@bms/shared';
import type { NotificationRecord } from './notifications.types.js';

/** The columns notifications.repository selects for a notification. */
export interface NotificationRow {
  id: string | number | bigint;
  branch_id: number | null;
  target_roles: string[];
  target_staff_id: number | null;
  event_type: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  severity: string;
  is_read: boolean;
  read_at: Date | null;
  created_at: Date;
}

export function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    id: String(row.id),
    branchId: row.branch_id,
    targetRoles: row.target_roles,
    targetStaffId: row.target_staff_id,
    eventType: row.event_type,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    severity: row.severity,
    isRead: row.is_read,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function toNotificationResponse(record: NotificationRecord): Notification {
  return {
    ...record,
    readAt: record.readAt ? record.readAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
}
