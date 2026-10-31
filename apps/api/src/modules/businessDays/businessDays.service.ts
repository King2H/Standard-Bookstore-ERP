import type { BusinessDayListQuery } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { localToday } from '../../lib/localDate.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './businessDays.policy.js';
import * as days from './businessDays.repository.js';
import type { Actor, BusinessDayRecord, BusinessMonthRecord, DayPreview, MonthPreview } from './businessDays.types.js';

/**
 * Use cases of closing days and months (#175, owner decisions 1a–6a,
 * 2026-10-31). One function each, owning its transaction. The ledger tables
 * themselves refuse writes in a closed day (migration 1700000094);
 * assertChangeable is what the flows that change an earlier day in place call.
 */

function audit(q: Queryable, actor: Actor, entityType: 'business_day' | 'business_month', id: number, meta: Record<string, unknown>, action: 'CREATE' | 'UPDATE') {
  return insertAuditEntry(q, { staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action, entityType, entityId: String(id), meta });
}

const foundDay = (d: BusinessDayRecord | undefined) => {
  if (d === undefined) throw new NotFoundError('Business day');
  return d;
};
const foundMonth = (m: BusinessMonthRecord | undefined) => {
  if (m === undefined) throw new NotFoundError('Business month');
  return m;
};

const monthOf = (day: string) => day.slice(0, 7);

async function monthClosed(q: Queryable, month: string): Promise<boolean> {
  return (await days.findMonthOf(q, month))?.status === 'closed';
}

// ── In-place changes (decision 3a) ────────────────────────────────────────────

/**
 * Refuses, in the caller's transaction, a change to a record of `branchId`
 * made at `recordedAt` when that day or its month is closed. `what` names the
 * record in the message, e.g. "This sale".
 */
export async function assertChangeable(q: Queryable, branchId: number, recordedAt: Date, what: string): Promise<void> {
  policy.checkChangeable(await days.closedPeriod(q, branchId, recordedAt), what);
}

// ── Days (decision 2a) ────────────────────────────────────────────────────────

/** The day as it stands: its report so far, or as kept once closed, and what stops it closing. */
export async function previewDay(branchId: number, day: string): Promise<DayPreview> {
  const [kept, openCashSessions, closedMonth] = await Promise.all([
    days.findDayOf(kysely, branchId, day),
    days.openCashSessions(kysely, branchId, day),
    monthClosed(kysely, monthOf(day)),
  ]);
  const report = kept?.status === 'closed' ? kept.report : policy.dayReport(await days.dayFigures(kysely, branchId, day));
  return {
    branchId,
    day,
    status: kept?.status ?? 'open',
    businessDayId: kept?.id ?? null,
    openCashSessions,
    monthClosed: closedMonth,
    report,
  };
}

export function listDays(branchId: number | undefined, query: BusinessDayListQuery): Promise<BusinessDayRecord[]> {
  return days.listDays(kysely, branchId, query.month);
}

export async function getDay(id: number): Promise<BusinessDayRecord> {
  return foundDay(await days.findDay(kysely, id));
}

/**
 * Closes the branch's day: the writes under way in the branch finish first
 * and new ones wait, so the report counts everything the day holds.
 */
export async function closeDay(actor: Actor, branchId: number, day: string): Promise<BusinessDayRecord> {
  return withTransaction({}, async (tx) => {
    await days.lockPeriods(tx);
    await days.lockBranchDay(tx, branchId);
    const [today, kept, openCashSessions, closedMonth] = await Promise.all([
      localToday(tx),
      days.findDayOf(tx, branchId, day),
      days.openCashSessions(tx, branchId, day),
      monthClosed(tx, monthOf(day)),
    ]);
    policy.checkDayClosable(day, today, { closed: kept?.status === 'closed', monthClosed: closedMonth, openCashSessions });
    const report = policy.dayReport(await days.dayFigures(tx, branchId, day));
    const dayNumber = await nextDailyNumber(tx, 'DAY');
    const id = await days.upsertClosedDay(tx, { branchId, day, dayNumber, report, closedBy: actor.staffId });
    await audit(tx, actor, 'business_day', id, { action: 'close', branchId, day, dayNumber, report }, kept ? 'UPDATE' : 'CREATE');
    return foundDay(await days.findDay(tx, id));
  });
}

/** An Admin reopens a closed day, saying why; a day of a closed month waits for the month (decision 5a). */
export async function reopenDay(actor: Actor, id: number, reason: string): Promise<BusinessDayRecord> {
  return withTransaction({}, async (tx) => {
    await days.lockPeriods(tx);
    const d = foundDay(await days.findDay(tx, id, { forUpdate: true }));
    policy.checkReopenable(d.status, 'day');
    policy.checkMonthOpenForDay(await monthClosed(tx, monthOf(d.day)), d.day);
    await days.reopenDay(tx, id, { reopenedBy: actor.staffId, reason });
    await audit(tx, actor, 'business_day', id, { action: 'reopen', branchId: d.branchId, day: d.day, dayNumber: d.dayNumber, reason }, 'UPDATE');
    await insertOutboxEvent(tx, 'business_day.reopened', {
      businessDayId: id, branchId: d.branchId, branchName: d.branchName, day: d.day, dayNumber: d.dayNumber, reason,
    });
    return foundDay(await days.findDay(tx, id));
  });
}

// ── Months (decisions 4a, 5a) ─────────────────────────────────────────────────

export async function previewMonth(month: string): Promise<MonthPreview> {
  const [kept, today, openDays, closedDays] = await Promise.all([
    days.findMonthOf(kysely, month),
    localToday(kysely),
    days.openDaysOf(kysely, month),
    days.closedDaysOf(kysely, month),
  ]);
  return {
    month,
    status: kept?.status ?? 'open',
    businessMonthId: kept?.id ?? null,
    ended: policy.monthEnded(month, today),
    openDays,
    summary: kept?.status === 'closed' ? kept.summary : policy.monthSummary(closedDays),
  };
}

export function listMonths(year: number): Promise<BusinessMonthRecord[]> {
  return days.listMonths(kysely, year);
}

export async function getMonth(id: number): Promise<BusinessMonthRecord> {
  return foundMonth(await days.findMonth(kysely, id));
}

/** Closes the month for the whole shop once every branch has closed each day it worked in it. */
export async function closeMonth(actor: Actor, month: string): Promise<BusinessMonthRecord> {
  return withTransaction({}, async (tx) => {
    await days.lockPeriods(tx);
    const [today, kept, openDays, closedDays] = await Promise.all([
      localToday(tx),
      days.findMonthOf(tx, month),
      days.openDaysOf(tx, month),
      days.closedDaysOf(tx, month),
    ]);
    policy.checkMonthClosable(month, today, { closed: kept?.status === 'closed', openDays });
    const summary = policy.monthSummary(closedDays);
    const id = await days.upsertClosedMonth(tx, { month, summary, closedBy: actor.staffId });
    await audit(tx, actor, 'business_month', id, { action: 'close', month, summary }, kept ? 'UPDATE' : 'CREATE');
    return foundMonth(await days.findMonth(tx, id));
  });
}

export async function reopenMonth(actor: Actor, id: number, reason: string): Promise<BusinessMonthRecord> {
  return withTransaction({}, async (tx) => {
    await days.lockPeriods(tx);
    const m = foundMonth(await days.findMonth(tx, id, { forUpdate: true }));
    policy.checkReopenable(m.status, 'month');
    await days.reopenMonth(tx, id, { reopenedBy: actor.staffId, reason });
    await audit(tx, actor, 'business_month', id, { action: 'reopen', month: m.month, reason }, 'UPDATE');
    await insertOutboxEvent(tx, 'business_month.reopened', { businessMonthId: id, month: m.month, reason, branchId: null });
    return foundMonth(await days.findMonth(tx, id));
  });
}
