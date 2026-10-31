import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { CUSTOMER_MONEY } from '../reports/payments/paymentReports.repository.js';
import type {
  BranchDays,
  BusinessDayRecord,
  BusinessMonthRecord,
  DayFigures,
  DayReport,
  MonthSummary,
  OpenCashSession,
} from './businessDays.types.js';

// Closed days and months (#175). Connections work in the shop's time zone
// (db/index.ts), so `x::date` is the shop's local day of a timestamp. Days
// belong to a branch: lists take the branch the controller scoped, single
// days are checked by recordInBranch() on the route.

type Closing = 'closed' | 'reopened';

// ── The calendar ──────────────────────────────────────────────────────────────

/**
 * Takes the branch's day lock alone, until the transaction ends: writes
 * under way in the branch finish first, and new ones wait (migration
 * 1700000094).
 */
export async function lockBranchDay(q: Queryable, branchId: number): Promise<void> {
  await sql`SELECT lock_business_day(${branchId}::integer, true)`.execute(q);
}

/**
 * Takes the shop's lock on closing and reopening, until the transaction
 * ends, so a month never closes while one of its days reopens.
 */
export async function lockPeriods(q: Queryable): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(176, NULLIF(current_setting('app.tenant_id', true), '')::integer)`.execute(q);
}

/** 'month' when the day's month is closed, 'day' when the branch's day is, else null. */
export async function closedPeriod(q: Queryable, branchId: number, at: Date | string): Promise<'day' | 'month' | null> {
  const { rows } = await sql<{ closed: 'day' | 'month' | null }>`
    SELECT closed_period(${branchId}::integer, ${at}::timestamptz::date) AS closed`.execute(q);
  return rows[0].closed;
}

// ── Days ──────────────────────────────────────────────────────────────────────

function selectDays(q: Queryable) {
  return q
    .selectFrom('business_days as d')
    .innerJoin('branches as b', 'b.id', 'd.branch_id')
    .innerJoin('staff as cb', 'cb.id', 'd.closed_by')
    .leftJoin('staff as rb', 'rb.id', 'd.reopened_by')
    .select([
      'd.id',
      'd.branch_id',
      'b.name as branch_name',
      sql<string>`d.day::text`.as('day'),
      'd.status',
      'd.day_number',
      'd.report',
      'd.closed_by',
      'cb.full_name as closed_by_name',
      'd.closed_at',
      'd.reopened_by',
      'rb.full_name as reopened_by_name',
      'd.reopened_at',
      'd.reopen_reason',
    ]);
}

type DayRow = Awaited<ReturnType<ReturnType<typeof selectDays>['executeTakeFirstOrThrow']>>;

function toDay(r: DayRow): BusinessDayRecord {
  return {
    id: r.id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    day: r.day,
    status: r.status as Closing,
    dayNumber: r.day_number,
    report: r.report as DayReport,
    closedBy: r.closed_by,
    closedByName: r.closed_by_name,
    closedAt: r.closed_at,
    reopenedBy: r.reopened_by,
    reopenedByName: r.reopened_by_name,
    reopenedAt: r.reopened_at,
    reopenReason: r.reopen_reason,
  };
}

export async function findDay(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<BusinessDayRecord | undefined> {
  let query = selectDays(q).where('d.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('d');
  const row = await query.executeTakeFirst();
  return row && toDay(row);
}

export async function findDayOf(q: Queryable, branchId: number, day: string): Promise<BusinessDayRecord | undefined> {
  const row = await selectDays(q).where('d.branch_id', '=', branchId).where('d.day', '=', sql<Date>`${day}::date`).executeTakeFirst();
  return row && toDay(row);
}

/** The branch's closed (or reopened) days in a month, oldest first. */
export async function listDays(q: Queryable, branchId: number | undefined, month: string): Promise<BusinessDayRecord[]> {
  let query = selectDays(q).where(sql<boolean>`date_trunc('month', d.day) = ${`${month}-01`}::date`);
  if (branchId !== undefined) query = query.where('d.branch_id', '=', branchId);
  return (await query.orderBy('d.day').orderBy('d.branch_id').execute()).map(toDay);
}

/** Closes a day not closed before, or closes a reopened one again with a new number and report. */
export async function upsertClosedDay(
  q: Queryable,
  d: { branchId: number; day: string; dayNumber: string; report: DayReport; closedBy: number },
): Promise<number> {
  const row = await q
    .insertInto('business_days')
    .values({
      branch_id: d.branchId,
      day: sql<Date>`${d.day}::date`,
      status: 'closed',
      day_number: d.dayNumber,
      report: JSON.stringify(d.report),
      closed_by: d.closedBy,
    })
    .onConflict((oc) =>
      oc.columns(['branch_id', 'day']).doUpdateSet({
        status: 'closed',
        day_number: d.dayNumber,
        report: JSON.stringify(d.report),
        closed_by: d.closedBy,
        closed_at: sql<Date>`now()`,
        reopened_by: null,
        reopened_at: null,
        reopen_reason: null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function reopenDay(q: Queryable, id: number, r: { reopenedBy: number; reason: string }): Promise<void> {
  await q
    .updateTable('business_days')
    .set({ status: 'reopened', reopened_by: r.reopenedBy, reopened_at: sql<Date>`now()`, reopen_reason: r.reason })
    .where('id', '=', id)
    .execute();
}

/** Cash sessions of the branch opened on or before the day and not closed: they stop the day closing. */
export async function openCashSessions(q: Queryable, branchId: number, day: string): Promise<OpenCashSession[]> {
  const rows = await q
    .selectFrom('cash_sessions as s')
    .innerJoin('staff as st', 'st.id', 's.staff_id')
    .select(['s.id', 'st.full_name as staff_name', 's.status'])
    .where('s.branch_id', '=', branchId)
    .where('s.status', '<>', 'closed')
    .where(sql<boolean>`s.opened_at::date <= ${day}::date`)
    .orderBy('s.id')
    .execute();
  return rows.map((r) => ({ id: r.id, staffName: r.staff_name, status: r.status }));
}

// ── A day's figures (decision 2a) ─────────────────────────────────────────────

/** What the branch did on the day, each part dated when it happened, as the reports date it. */
export async function dayFigures(q: Queryable, branchId: number, day: string): Promise<DayFigures> {
  const [orders, pos, exchanges, money, returns, stock, cash] = await Promise.all([
    sql<{ count: number; total: string }>`
      SELECT COALESCE(SUM(ev.sign), 0)::integer AS count, COALESCE(SUM(ev.sign * o.total), 0)::text AS total
      FROM order_sale_events ev JOIN orders o ON o.id = ev.order_id
      WHERE o.branch_id = ${branchId} AND ev.sale_at::date = ${day}::date`.execute(q),
    sql<{ count: number; total: string }>`
      SELECT COUNT(*)::integer AS count, COALESCE(SUM(t.grand_total), 0)::text AS total
      FROM transactions t
      WHERE t.branch_id = ${branchId} AND t.status = 'completed' AND t.created_at::date = ${day}::date`.execute(q),
    sql<{ count: number }>`
      SELECT COUNT(*)::integer AS count FROM exchanges e
      WHERE e.branch_id = ${branchId} AND e.status IN ('Completed', 'COMPLETED') AND e.created_at::date = ${day}::date`.execute(q),
    // Customer money as the payment reports count it, and what suppliers were paid or refunded.
    sql<{ method: string; in: string; out: string }>`
      ${sql.raw(CUSTOMER_MONEY)},
      supplier AS (
        SELECT sp.payment_method AS method, sp.amount, 'out' AS direction, sp.created_at AS at, sp.branch_id
        FROM supplier_payments sp WHERE sp.reversed_at IS NULL
        UNION ALL
        SELECT sr.refund_method, sr.amount, 'in', sr.created_at, sr.branch_id FROM supplier_refunds sr
      ),
      moved AS (
        SELECT method, amount, direction, at, branch_id FROM money
        UNION ALL
        SELECT method, amount, direction, at, branch_id FROM supplier
      )
      SELECT m.method,
             COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'in'), 0)::text AS "in",
             COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'out'), 0)::text AS "out"
      FROM moved m
      WHERE m.branch_id = ${branchId} AND m.at::date = ${day}::date
      GROUP BY m.method
      ORDER BY m.method`.execute(q),
    sql<{ count: number; refunded: string }>`
      SELECT COUNT(*)::integer AS count,
             COALESCE((SELECT SUM(rf.amount) FROM refunds rf JOIN returns r2 ON r2.id = rf.return_id
                       WHERE r2.branch_id = ${branchId} AND r2.status = 'completed' AND rf.method <> 'credit_note'
                         AND rf.created_at::date = ${day}::date), 0)::text AS refunded
      FROM returns r
      WHERE r.branch_id = ${branchId} AND r.status = 'completed' AND r.created_at::date = ${day}::date`.execute(q),
    sql<{ reason: string; in: number; out: number }>`
      SELECT h.reason_code AS reason,
             COALESCE(SUM(h.delta) FILTER (WHERE h.delta > 0), 0)::integer AS "in",
             COALESCE(-SUM(h.delta) FILTER (WHERE h.delta < 0), 0)::integer AS "out"
      FROM inventory_history h JOIN locations l ON l.id = h.location_id
      WHERE l.branch_id = ${branchId} AND h.delta <> 0 AND h.created_at::date = ${day}::date
      GROUP BY h.reason_code
      ORDER BY h.reason_code`.execute(q),
    sql<{ id: number; z_number: string | null; staff_name: string; expected: string; counted: string; variance: string }>`
      SELECT s.id, s.z_number, st.full_name AS staff_name,
             s.expected_cash::text AS expected, s.counted_cash::text AS counted, s.variance::text AS variance
      FROM cash_sessions s JOIN staff st ON st.id = s.staff_id
      WHERE s.branch_id = ${branchId} AND s.status = 'closed' AND s.opened_at::date = ${day}::date
      ORDER BY s.id`.execute(q),
  ]);
  return {
    orders: orders.rows[0],
    pos: pos.rows[0],
    exchanges: exchanges.rows[0].count,
    money: money.rows,
    returns: returns.rows[0],
    stock: stock.rows,
    cash: cash.rows.map((r) => ({ id: r.id, zNumber: r.z_number, staffName: r.staff_name, expected: r.expected, counted: r.counted, variance: r.variance })),
  };
}

// ── Months (decision 4a) ──────────────────────────────────────────────────────

function selectMonths(q: Queryable) {
  return q
    .selectFrom('business_months as m')
    .innerJoin('staff as cb', 'cb.id', 'm.closed_by')
    .leftJoin('staff as rb', 'rb.id', 'm.reopened_by')
    .select([
      'm.id',
      sql<string>`to_char(m.month, 'YYYY-MM')`.as('month'),
      'm.status',
      'm.summary',
      'm.closed_by',
      'cb.full_name as closed_by_name',
      'm.closed_at',
      'm.reopened_by',
      'rb.full_name as reopened_by_name',
      'm.reopened_at',
      'm.reopen_reason',
    ]);
}

type MonthRow = Awaited<ReturnType<ReturnType<typeof selectMonths>['executeTakeFirstOrThrow']>>;

function toMonth(r: MonthRow): BusinessMonthRecord {
  return {
    id: r.id,
    month: r.month,
    status: r.status as Closing,
    summary: r.summary as MonthSummary,
    closedBy: r.closed_by,
    closedByName: r.closed_by_name,
    closedAt: r.closed_at,
    reopenedBy: r.reopened_by,
    reopenedByName: r.reopened_by_name,
    reopenedAt: r.reopened_at,
    reopenReason: r.reopen_reason,
  };
}

export async function findMonth(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<BusinessMonthRecord | undefined> {
  let query = selectMonths(q).where('m.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('m');
  const row = await query.executeTakeFirst();
  return row && toMonth(row);
}

export async function findMonthOf(q: Queryable, month: string): Promise<BusinessMonthRecord | undefined> {
  const row = await selectMonths(q).where('m.month', '=', sql<Date>`${`${month}-01`}::date`).executeTakeFirst();
  return row && toMonth(row);
}

export async function listMonths(q: Queryable, year: number): Promise<BusinessMonthRecord[]> {
  return (await selectMonths(q).where(sql<boolean>`extract(year FROM m.month) = ${year}`).orderBy('m.month').execute()).map(toMonth);
}

export async function upsertClosedMonth(q: Queryable, m: { month: string; summary: MonthSummary; closedBy: number }): Promise<number> {
  const row = await q
    .insertInto('business_months')
    .values({ month: sql<Date>`${`${m.month}-01`}::date`, status: 'closed', summary: JSON.stringify(m.summary), closed_by: m.closedBy })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'month']).doUpdateSet({
        status: 'closed',
        summary: JSON.stringify(m.summary),
        closed_by: m.closedBy,
        closed_at: sql<Date>`now()`,
        reopened_by: null,
        reopened_at: null,
        reopen_reason: null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function reopenMonth(q: Queryable, id: number, r: { reopenedBy: number; reason: string }): Promise<void> {
  await q
    .updateTable('business_months')
    .set({ status: 'reopened', reopened_by: r.reopenedBy, reopened_at: sql<Date>`now()`, reopen_reason: r.reason })
    .where('id', '=', id)
    .execute();
}

/**
 * The days of the month each branch worked and has not closed: a day with
 * anything recorded in the branch, from a sale to a stock movement.
 */
export async function openDaysOf(q: Queryable, month: string): Promise<BranchDays[]> {
  const from = `${month}-01`;
  const { rows } = await sql<{ branch_id: number; branch_name: string; days: string[] }>`
    WITH bounds AS (SELECT ${from}::date AS first, (${from}::date + interval '1 month')::date AS next),
    worked AS (
      SELECT branch_id, created_at AS at FROM transactions
      UNION ALL SELECT branch_id, created_at FROM orders
      UNION ALL SELECT o.branch_id, ev.sale_at FROM order_sale_events ev JOIN orders o ON o.id = ev.order_id
      UNION ALL SELECT o.branch_id, op.created_at FROM order_payments op JOIN orders o ON o.id = op.order_id
      UNION ALL SELECT o.branch_id, d.delivered_at FROM order_deliveries d JOIN orders o ON o.id = d.order_id
      UNION ALL SELECT branch_id, created_at FROM returns
      UNION ALL SELECT branch_id, created_at FROM exchanges
      UNION ALL SELECT l.branch_id, h.created_at FROM inventory_history h JOIN locations l ON l.id = h.location_id
      UNION ALL SELECT branch_id, opened_at FROM cash_sessions
      UNION ALL SELECT branch_id, created_at FROM financial_transactions
      UNION ALL SELECT branch_id, created_at FROM supplier_payments
      UNION ALL SELECT branch_id, created_at FROM supplier_refunds
      UNION ALL SELECT branch_id, created_at FROM supplier_credit_notes
    ),
    days AS (
      SELECT DISTINCT w.branch_id, w.at::date AS day
      FROM worked w, bounds
      WHERE w.at >= bounds.first AND w.at < bounds.next
    )
    SELECT b.id AS branch_id, b.name AS branch_name, array_agg(days.day::text ORDER BY days.day) AS days
    FROM days
    JOIN branches b ON b.id = days.branch_id
    WHERE NOT EXISTS (SELECT 1 FROM business_days bd WHERE bd.branch_id = days.branch_id AND bd.day = days.day AND bd.status = 'closed')
    GROUP BY b.id, b.name
    ORDER BY b.name`.execute(q);
  return rows.map((r) => ({ branchId: r.branch_id, branchName: r.branch_name, days: r.days }));
}

/** The month's closed days of every branch, for its summary. */
export async function closedDaysOf(q: Queryable, month: string): Promise<BusinessDayRecord[]> {
  return listDays(q, undefined, month).then((days) => days.filter((d) => d.status === 'closed'));
}
