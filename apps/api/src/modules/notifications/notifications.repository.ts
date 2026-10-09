import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { toNotificationRecord } from './notifications.mapper.js';
import type { NewNotification, NotificationRecord, Recipient } from './notifications.types.js';

// Every read and update is limited to the notifications the recipient may
// see: those addressed to them, and those for their role in their session
// branch or system-wide; staff with access to all branches see every branch
// (#12). Tenant scope arrives with tenancy (#13).
//
// Read state is per person (#85): a notification is read for a recipient when
// they read it (notification_reads), or when it was read before per-person
// tracking began (notifications.is_read).

function visibleTo(r: Recipient) {
  return sql<boolean>`(
    n.target_staff_id = ${r.staffId}
    OR (${r.role} = ANY(n.target_roles) AND (n.branch_id IS NULL OR n.branch_id = ${r.branchId} OR ${r.allBranches}))
  )`;
}

function readBy(r: Recipient) {
  return sql<boolean>`(n.is_read OR EXISTS (
    SELECT 1 FROM notification_reads nr WHERE nr.notification_id = n.id AND nr.staff_id = ${r.staffId}
  ))`;
}

export async function list(
  q: Queryable,
  r: Recipient,
  filter: { isRead?: boolean; severity?: string },
  page: { limit: number; offset: number },
): Promise<{ items: NotificationRecord[]; total: number }> {
  let query = q.selectFrom('notifications as n').where(visibleTo(r));
  if (filter.isRead !== undefined) query = query.where(filter.isRead ? readBy(r) : sql<boolean>`NOT ${readBy(r)}`);
  if (filter.severity !== undefined) query = query.where('n.severity', '=', filter.severity);

  const [rows, count] = await Promise.all([
    query
      .leftJoin('notification_reads as mine', (join) =>
        join.onRef('mine.notification_id', '=', 'n.id').on('mine.staff_id', '=', r.staffId),
      )
      .select([
        'n.id',
        'n.branch_id',
        'n.target_roles',
        'n.target_staff_id',
        'n.event_type',
        'n.title',
        'n.body',
        'n.entity_type',
        'n.entity_id',
        'n.severity',
        sql<boolean>`(n.is_read OR mine.staff_id IS NOT NULL)`.as('is_read'),
        sql<Date | null>`COALESCE(mine.read_at, n.read_at)`.as('read_at'),
        'n.created_at',
      ])
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toNotificationRecord), total: Number(count.count) };
}

export async function countUnread(q: Queryable, r: Recipient): Promise<number> {
  const row = await q
    .selectFrom('notifications as n')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where(visibleTo(r))
    .where(sql<boolean>`NOT ${readBy(r)}`)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Records that the recipient read the notification; nothing happens if they may not see it. */
export async function markRead(q: Queryable, r: Recipient, id: number): Promise<void> {
  await markReadWhere(q, r, String(id));
}

/** Records every unread notification the recipient may see as read by them; returns how many. */
export async function markAllRead(q: Queryable, r: Recipient): Promise<number> {
  return markReadWhere(q, r);
}

async function markReadWhere(q: Queryable, r: Recipient, id?: string): Promise<number> {
  let unread = q
    .selectFrom('notifications as n')
    .select((eb) => ['n.id', eb.val(r.staffId).as('staff_id')])
    .where(visibleTo(r))
    .where(sql<boolean>`NOT ${readBy(r)}`);
  if (id !== undefined) unread = unread.where('n.id', '=', id);

  const result = await q
    .insertInto('notification_reads')
    .columns(['notification_id', 'staff_id'])
    .expression(unread)
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n);
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
