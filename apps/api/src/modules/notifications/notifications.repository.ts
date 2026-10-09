import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { toNotificationRecord } from './notifications.mapper.js';
import type { NewNotification, NotificationRecord, Recipient } from './notifications.types.js';

// Every read and update is limited to the notifications the recipient may
// see: those addressed to them, and those for their role in their session
// branch or system-wide; staff with access to all branches see every branch
// (#12). Tenant scope arrives with tenancy (#13).

function visibleTo(r: Recipient) {
  return sql<boolean>`(
    target_staff_id = ${r.staffId}
    OR (${r.role} = ANY(target_roles) AND (branch_id IS NULL OR branch_id = ${r.branchId} OR ${r.allBranches}))
  )`;
}

const COLUMNS = [
  'id',
  'branch_id',
  'target_roles',
  'target_staff_id',
  'event_type',
  'title',
  'body',
  'entity_type',
  'entity_id',
  'severity',
  'is_read',
  'read_at',
  'created_at',
] as const;

export async function list(
  q: Queryable,
  r: Recipient,
  filter: { isRead?: boolean; severity?: string },
  page: { limit: number; offset: number },
): Promise<{ items: NotificationRecord[]; total: number }> {
  let query = q.selectFrom('notifications').where(visibleTo(r));
  if (filter.isRead !== undefined) query = query.where('is_read', '=', filter.isRead);
  if (filter.severity !== undefined) query = query.where('severity', '=', filter.severity);

  const [rows, count] = await Promise.all([
    query.select(COLUMNS).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toNotificationRecord), total: Number(count.count) };
}

export async function countUnread(q: Queryable, r: Recipient): Promise<number> {
  const row = await q
    .selectFrom('notifications')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('is_read', '=', false)
    .where(visibleTo(r))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Marks one notification read; nothing happens if the recipient may not see it. */
export async function markRead(q: Queryable, r: Recipient, id: number): Promise<void> {
  await q
    .updateTable('notifications')
    .set({ is_read: true, read_at: sql`now()` })
    .where('id', '=', String(id))
    .where('is_read', '=', false)
    .where(visibleTo(r))
    .execute();
}

/** Marks every unread notification the recipient may see as read; returns how many. */
export async function markAllRead(q: Queryable, r: Recipient): Promise<number> {
  const result = await q
    .updateTable('notifications')
    .set({ is_read: true, read_at: sql`now()` })
    .where('is_read', '=', false)
    .where(visibleTo(r))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function insert(q: Queryable, n: NewNotification): Promise<{ id: string; createdAt: Date }> {
  const row = await q
    .insertInto('notifications')
    .values({
      branch_id: n.branchId,
      target_roles: n.targetRoles,
      event_type: n.eventType,
      title: n.title,
      body: n.body,
      entity_type: n.entityType,
      entity_id: n.entityId,
      severity: n.severity,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: String(row.id), createdAt: row.created_at };
}
