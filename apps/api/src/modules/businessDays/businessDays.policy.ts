import { Money } from '@bms/shared';
import { BusinessError, ConflictError } from '../../lib/errors.js';
import type { BranchDays, BusinessDayRecord, DayFigures, DayReport, MonthSummary, OpenCashSession } from './businessDays.types.js';

/**
 * Rules of closing days and months (#175, owner decisions 2a–5a). Pure: the
 * service hands in what the database holds. Days and months compare as
 * YYYY-MM-DD and YYYY-MM text, the shop's local calendar.
 */

const amount = (v: string) => Money.of(v).toNumber();

/** A day closes once it has begun, is not closed already, its month is open and its cash sessions are closed. */
export function checkDayClosable(
  day: string,
  today: string,
  state: { closed: boolean; monthClosed: boolean; openCashSessions: OpenCashSession[] },
): void {
  if (day > today) throw new BusinessError('DAY_IN_FUTURE', `${day} has not begun; a day closes once it has`);
  if (state.monthClosed) throw new ConflictError('MONTH_CLOSED', `The month of ${day} is closed; ask an Admin to reopen it`);
  if (state.closed) throw new ConflictError('DAY_ALREADY_CLOSED', `${day} is already closed in this branch`);
  if (state.openCashSessions.length > 0) {
    throw new BusinessError('CASH_SESSIONS_OPEN', `Close every cash session of ${day} first: ${state.openCashSessions.map((s) => s.staffName).join(', ')}`, {
      openCashSessions: state.openCashSessions,
    });
  }
}

/** Only a closed day or month reopens. */
export function checkReopenable(status: 'closed' | 'reopened', what: 'day' | 'month'): void {
  if (status !== 'closed') {
    throw new ConflictError(what === 'day' ? 'DAY_NOT_CLOSED' : 'MONTH_NOT_CLOSED', `This ${what} is not closed`);
  }
}

/** A day of a closed month reopens only after the month does (decision 5a). */
export function checkMonthOpenForDay(monthClosed: boolean, day: string): void {
  if (monthClosed) throw new ConflictError('MONTH_CLOSED', `The month of ${day} is closed; reopen the month first`);
}

/** The month's last day has passed. */
export function monthEnded(month: string, today: string): boolean {
  return today.slice(0, 7) > month;
}

/** A month closes once it has ended, is not closed already, and every branch has closed each day it worked. */
export function checkMonthClosable(month: string, today: string, state: { closed: boolean; openDays: BranchDays[] }): void {
  if (!monthEnded(month, today)) throw new BusinessError('MONTH_NOT_ENDED', `${month} has not ended; a month closes once it has`);
  if (state.closed) throw new ConflictError('MONTH_ALREADY_CLOSED', `${month} is already closed`);
  if (state.openDays.length > 0) {
    throw new BusinessError(
      'MONTH_HAS_OPEN_DAYS',
      `Every branch closes the days it worked first: ${state.openDays.map((b) => `${b.branchName} (${b.days.length})`).join(', ')}`,
      { openDays: state.openDays },
    );
  }
}

/**
 * An in-place change (decision 3a): voiding a sale or an exchange, or
 * reversing a supplier payment, changes the figures of the day it was
 * recorded on, so that day must be open. `closed` is that day's state.
 */
export function checkChangeable(closed: 'day' | 'month' | null, what: string): void {
  if (closed === 'month') throw new ConflictError('MONTH_CLOSED', `${what} belongs to a closed month; record a correction on an open day instead`);
  if (closed === 'day') throw new ConflictError('DAY_CLOSED', `${what} belongs to a closed day; record a correction on an open day instead`);
}

/** The day report from the figures the database summed (decision 2a). */
export function dayReport(f: DayFigures): DayReport {
  const totalIn = Money.sum(f.money.map((m) => m.in));
  const totalOut = Money.sum(f.money.map((m) => m.out));
  return {
    sales: {
      orders: { count: f.orders.count, total: amount(f.orders.total) },
      pos: { count: f.pos.count, total: amount(f.pos.total) },
      exchanges: { count: f.exchanges },
    },
    money: {
      byMethod: f.money.map((m) => ({ method: m.method, in: amount(m.in), out: amount(m.out) })),
      totalIn: totalIn.toNumber(),
      totalOut: totalOut.toNumber(),
    },
    returns: { count: f.returns.count, refunded: amount(f.returns.refunded) },
    stock: f.stock,
    cash: {
      sessions: f.cash.map((s) => ({ ...s, expected: amount(s.expected), counted: amount(s.counted), variance: amount(s.variance) })),
      totalVariance: Money.sum(f.cash.map((s) => s.variance)).toNumber(),
    },
  };
}

/** The month summary: each branch's closed days added up, and the shop's total (decision 4a). */
export function monthSummary(days: BusinessDayRecord[]): MonthSummary {
  const byBranch = new Map<number, { branchName: string; days: BusinessDayRecord[] }>();
  for (const d of days) {
    const entry = byBranch.get(d.branchId) ?? { branchName: d.branchName, days: [] };
    entry.days.push(d);
    byBranch.set(d.branchId, entry);
  }
  const add = (list: BusinessDayRecord[], pick: (r: DayReport) => number) => Money.sum(list.map((d) => String(pick(d.report))));
  const totalsOf = (list: BusinessDayRecord[]) => ({
    days: list.length,
    sales: add(list, (r) => r.sales.orders.total).plus(add(list, (r) => r.sales.pos.total)).toNumber(),
    moneyIn: add(list, (r) => r.money.totalIn).toNumber(),
    moneyOut: add(list, (r) => r.money.totalOut).toNumber(),
    refunded: add(list, (r) => r.returns.refunded).toNumber(),
    cashVariance: add(list, (r) => r.cash.totalVariance).toNumber(),
  });
  const branches = [...byBranch.entries()]
    .map(([branchId, b]) => ({ branchId, branchName: b.branchName, ...totalsOf(b.days) }))
    .sort((a, b) => a.branchName.localeCompare(b.branchName));
  return { branches, totals: totalsOf(days) };
}
