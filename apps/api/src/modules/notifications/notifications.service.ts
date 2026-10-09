import { kysely } from '../../db/kysely.js';
import * as notifications from './notifications.repository.js';
import type { NewNotification, NotificationRecord, Recipient } from './notifications.types.js';

/** Use cases of the Notifications module (A4). */

export async function listNotifications(
  recipient: Recipient,
  filter: { isRead?: boolean; severity?: string },
  paging: { page: number; pageSize: number },
): Promise<{ items: NotificationRecord[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const { page, pageSize } = paging;
  const { items, total } = await notifications.list(kysely, recipient, filter, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export function countUnread(recipient: Recipient): Promise<number> {
  return notifications.countUnread(kysely, recipient);
}

export function markRead(recipient: Recipient, id: number): Promise<void> {
  return notifications.markRead(kysely, recipient, id);
}

export function markAllRead(recipient: Recipient): Promise<number> {
  return notifications.markAllRead(kysely, recipient);
}

/** Stores a notification produced by the outbox worker. */
export function createNotification(n: NewNotification): Promise<{ id: string; createdAt: Date }> {
  return notifications.insert(kysely, n);
}
