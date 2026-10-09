import type { Request, Response } from 'express';
import {
  NotificationIdParamsSchema,
  NotificationListQuerySchema,
  type MarkAllReadResponse,
  type MarkReadResponse,
  type NotificationListResponse,
  type UnreadCountResponse,
} from '@bms/shared';
import { scopeOf } from '../../lib/scope.js';
import { sseManager } from '../../lib/sseManager.js';
import { valid } from '../../middleware/validate.js';
import { toNotificationResponse } from './notifications.mapper.js';
import * as service from './notifications.service.js';
import type { Recipient } from './notifications.types.js';

/**
 * HTTP side of the Notifications module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: NotificationListQuerySchema },
  byId: { params: NotificationIdParamsSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function recipient(req: Request): Recipient {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId, allBranches: scopeOf(req).allBranches };
}

/** Server-sent events: the unread count on connect, then each new notification. */
export function stream(req: Request, res: Response): void {
  const staff = req.staff!;
  // sseManager sets the headers and forgets the connection when it closes.
  sseManager.register(staff.staffId, staff.branchId, staff.role, res);

  service
    .countUnread(recipient(req))
    .catch(() => 0)
    .then((unreadCount) => res.write(`event: connected\ndata: ${JSON.stringify({ unreadCount })}\n\n`));

  // A comment every 30 s keeps the connection open through proxies.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);
  res.on('close', () => clearInterval(heartbeat));
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listNotifications(
    recipient(req),
    { isRead: query.isRead, severity: query.severity },
    { page: query.page, pageSize: query.pageSize },
  );
  const { items, ...paging } = result;
  const body: NotificationListResponse = { data: items.map(toNotificationResponse), ...paging };
  res.json(body);
}

export async function unreadCount(req: Request, res: Response): Promise<void> {
  const body: UnreadCountResponse = { count: await service.countUnread(recipient(req)) };
  res.json(body);
}

export async function markRead(req: Request, res: Response): Promise<void> {
  await service.markRead(recipient(req), valid(req, schemas.byId).params.id);
  const body: MarkReadResponse = { success: true };
  res.json(body);
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  const body: MarkAllReadResponse = { updated: await service.markAllRead(recipient(req)) };
  res.json(body);
}
