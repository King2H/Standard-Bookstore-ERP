import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { SHOP_CURRENCY } from '../config/config.repository.js';
import type {
  CashMovementCategory,
  CashMovementKind,
  CashMovementRecord,
  CashSessionFilter,
  CashSessionRecord,
  CashSessionStatus,
  CashTotal,
} from './cashSessions.types.js';

// Cash sessions belong to a branch (#171): lists take the branch the
// controller scoped; single sessions are checked by recordInBranch() on the
// route and by cashSessions.policy for each action.

type Page = { limit: number; offset: number };

const money = (v: string | null) => (v === null ? null : Money.of(v));

function selectSessions(q: Queryable) {
  return q
    .selectFrom('cash_sessions as s')
    .innerJoin('branches as b', 'b.id', 's.branch_id')
    .innerJoin('staff as st', 'st.id', 's.staff_id')
    .leftJoin('staff as cb', 'cb.id', 's.closed_by')
    .leftJoin('staff as rb', 'rb.id', 's.reviewed_by')
    .select([
      's.id',
      's.branch_id',
      'b.name as branch_name',
      's.staff_id',
      'st.full_name as staff_name',
      's.status',
      's.currency',
      's.opening_float',
      's.opened_at',
      's.expected_cash',
      's.counted_cash',
      's.variance',
      's.close_note',
      's.closed_by',
      'cb.full_name as closed_by_name',
      's.closed_at',
      's.z_number',
      's.reviewed_by',
      'rb.full_name as reviewed_by_name',
      's.reviewed_at',
      's.review_reason',
    ]);
}

type SessionRow = Awaited<ReturnType<ReturnType<typeof selectSessions>['executeTakeFirstOrThrow']>>;

function toRecord(r: SessionRow): CashSessionRecord {
  return {
    id: r.id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    staffId: r.staff_id,
    staffName: r.staff_name,
    status: r.status as CashSessionStatus,
    currency: r.currency,
    openingFloat: Money.of(r.opening_float),
    openedAt: r.opened_at,
    expectedCash: money(r.expected_cash),
    countedCash: money(r.counted_cash),
    variance: money(r.variance),
    closeNote: r.close_note,
    closedBy: r.closed_by,
    closedByName: r.closed_by_name,
    closedAt: r.closed_at,
    zNumber: r.z_number,
    reviewedBy: r.reviewed_by,
    reviewedByName: r.reviewed_by_name,
    reviewedAt: r.reviewed_at,
    reviewReason: r.review_reason,
  };
}

/** One session; with `forUpdate`, locked until the transaction ends, so a movement and the close take turns. */
export async function findSession(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<CashSessionRecord | undefined> {
  let query = selectSessions(q).where('s.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('s');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

/** The staff member's open session in the branch, locked like findSession's. */
export async function findOpenSession(
  q: Queryable,
  staffId: number,
  branchId: number,
  opts: { forUpdate?: boolean } = {},
): Promise<CashSessionRecord | undefined> {
  let query = selectSessions(q).where('s.staff_id', '=', staffId).where('s.branch_id', '=', branchId).where('s.status', '=', 'open');
  if (opts.forUpdate) query = query.forUpdate('s');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

/** The session that recorded a movement, if it is still open; locked. */
export async function findOpenSessionOf(q: Queryable, kind: CashMovementKind, sourceId: string): Promise<number | undefined> {
  const row = await q
    .selectFrom('cash_session_movements as m')
    .innerJoin('cash_sessions as s', 's.id', 'm.session_id')
    .select('s.id')
    .where('m.kind', '=', kind)
    .where('m.source_id', '=', sourceId)
    .where('s.status', '=', 'open')
    .forUpdate('s')
    .executeTakeFirst();
  return row?.id;
}

export async function list(q: Queryable, filter: CashSessionFilter, page: Page): Promise<{ items: CashSessionRecord[]; total: number }> {
  let query = selectSessions(q);
  if (filter.branchId !== null) query = query.where('s.branch_id', '=', filter.branchId);
  if (filter.staffId !== undefined) query = query.where('s.staff_id', '=', filter.staffId);
  if (filter.status) query = query.where('s.status', '=', filter.status);
  if (filter.dateFrom) query = query.where(sql<boolean>`s.opened_at::date >= ${filter.dateFrom}::date`);
  if (filter.dateTo) query = query.where(sql<boolean>`s.opened_at::date <= ${filter.dateTo}::date`);

  const [rows, count] = await Promise.all([
    query.orderBy('s.opened_at', 'desc').orderBy('s.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

export async function movements(q: Queryable, sessionId: number): Promise<CashMovementRecord[]> {
  const rows = await q
    .selectFrom('cash_session_movements as m')
    .innerJoin('staff as st', 'st.id', 'm.staff_id')
    .select(['m.id', 'm.kind', 'm.source_id', 'm.method', 'm.direction', 'm.amount', 'm.category', 'm.reason', 'm.staff_id', 'st.full_name as staff_name', 'm.created_at'])
    .where('m.session_id', '=', sessionId)
    .orderBy('m.id')
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind as CashMovementKind,
    sourceId: r.source_id,
    method: r.method,
    direction: r.direction as 'in' | 'out',
    amount: Money.of(r.amount),
    category: r.category as CashMovementCategory | null,
    reason: r.reason,
    staffId: r.staff_id,
    staffName: r.staff_name,
    createdAt: r.created_at,
  }));
}

/** What moved, by kind, method and direction: the X and Z reports. */
export async function totals(q: Queryable, sessionId: number): Promise<CashTotal[]> {
  const rows = await q
    .selectFrom('cash_session_movements')
    .select(['kind', 'method', 'direction', (eb) => eb.fn.countAll<string>().as('count'), (eb) => eb.fn.sum<string>('amount').as('amount')])
    .where('session_id', '=', sessionId)
    .groupBy(['kind', 'method', 'direction'])
    .orderBy('kind')
    .orderBy('method')
    .orderBy('direction')
    .execute();
  return rows.map((r) => ({
    kind: r.kind as CashMovementKind,
    method: r.method,
    direction: r.direction as 'in' | 'out',
    count: Number(r.count),
    amount: Money.of(r.amount),
  }));
}

/** The float plus cash in less cash out, from the rows. */
export async function expectedCash(q: Queryable, sessionId: number): Promise<Money> {
  const row = await sql<{ expected: string }>`
    SELECT s.opening_float + COALESCE(SUM(CASE m.direction WHEN 'in' THEN m.amount ELSE -m.amount END) FILTER (WHERE m.method = 'cash'), 0) AS expected
    FROM cash_sessions s LEFT JOIN cash_session_movements m ON m.session_id = s.id
    WHERE s.id = ${sessionId}
    GROUP BY s.id`.execute(q);
  return Money.of(row.rows[0].expected);
}

export async function insertSession(q: Queryable, s: { branchId: number; staffId: number; openingFloat: Money }): Promise<number> {
  const row = await q
    .insertInto('cash_sessions')
    .values({ branch_id: s.branchId, staff_id: s.staffId, opening_float: s.openingFloat.toFixed(2), currency: SHOP_CURRENCY })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function insertMovement(
  q: Queryable,
  m: {
    sessionId: number;
    kind: CashMovementKind;
    sourceId: string | null;
    method: string;
    direction: 'in' | 'out';
    amount: Money;
    category: CashMovementCategory | null;
    reason: string | null;
    staffId: number;
  },
): Promise<number> {
  const row = await q
    .insertInto('cash_session_movements')
    .values({
      session_id: m.sessionId,
      kind: m.kind,
      source_id: m.sourceId,
      method: m.method,
      direction: m.direction,
      amount: m.amount.toFixed(2),
      category: m.category,
      reason: m.reason,
      staff_id: m.staffId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export async function close(
  q: Queryable,
  id: number,
  c: { status: CashSessionStatus; expected: Money; counted: Money; variance: Money; note: string | null; closedBy: number; zNumber: string },
): Promise<void> {
  await q
    .updateTable('cash_sessions')
    .set({
      status: c.status,
      expected_cash: c.expected.toFixed(2),
      counted_cash: c.counted.toFixed(2),
      variance: c.variance.toFixed(2),
      close_note: c.note,
      closed_by: c.closedBy,
      closed_at: sql`now()`,
      z_number: c.zNumber,
    })
    .where('id', '=', id)
    .execute();
}

export async function review(q: Queryable, id: number, r: { reviewedBy: number; reason: string }): Promise<void> {
  await q
    .updateTable('cash_sessions')
    .set({ status: 'closed', reviewed_by: r.reviewedBy, reviewed_at: sql`now()`, review_reason: r.reason })
    .where('id', '=', id)
    .execute();
}
