import { describe, it, expect } from 'vitest';
import {
  checkChangeable,
  checkDayClosable,
  checkMonthClosable,
  checkMonthOpenForDay,
  checkReopenable,
  dayReport,
  monthEnded,
  monthSummary,
} from '../businessDays.policy.js';
import type { BusinessDayRecord, DayFigures } from '../businessDays.types.js';

// #175: the rules of closing days and months, without a database.

const open = { closed: false, monthClosed: false, openCashSessions: [] };
const code = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return (err as { code: string }).code;
  }
  return undefined;
};

const figures: DayFigures = {
  orders: { count: 2, total: '100.10' },
  pos: { count: 3, total: '0.20' },
  exchanges: 1,
  money: [
    { method: 'bank', in: '0', out: '30.00' },
    { method: 'cash', in: '100.10', out: '0.20' },
  ],
  returns: { count: 1, refunded: '0.20' },
  stock: [{ reason: 'sale', in: 0, out: 4 }],
  cash: [
    { id: 1, zNumber: 'Z-1', staffName: 'A', expected: '10.10', counted: '10.00', variance: '-0.10' },
    { id: 2, zNumber: 'Z-2', staffName: 'B', expected: '5.00', counted: '5.30', variance: '0.30' },
  ],
};

function closedDay(branchId: number, branchName: string, f: Partial<DayFigures> = {}): BusinessDayRecord {
  return {
    id: branchId,
    branchId,
    branchName,
    day: '2026-10-01',
    status: 'closed',
    dayNumber: 'DAY-1',
    report: dayReport({ ...figures, ...f }),
    closedBy: 1,
    closedByName: 'X',
    closedAt: new Date(),
    reopenedBy: null,
    reopenedByName: null,
    reopenedAt: null,
    reopenReason: null,
  };
}

describe('closing a day', () => {
  it('closes today or an earlier day, not a later one', () => {
    expect(code(() => checkDayClosable('2026-10-31', '2026-10-31', open))).toBeUndefined();
    expect(code(() => checkDayClosable('2026-10-01', '2026-10-31', open))).toBeUndefined();
    expect(code(() => checkDayClosable('2026-11-01', '2026-10-31', open))).toBe('DAY_IN_FUTURE');
  });

  it('waits for the cash sessions, refuses a closed day or a day of a closed month', () => {
    expect(code(() => checkDayClosable('2026-10-31', '2026-10-31', { ...open, openCashSessions: [{ id: 1, staffName: 'A', status: 'open' }] }))).toBe('CASH_SESSIONS_OPEN');
    expect(code(() => checkDayClosable('2026-10-31', '2026-10-31', { ...open, closed: true }))).toBe('DAY_ALREADY_CLOSED');
    expect(code(() => checkDayClosable('2026-10-01', '2026-10-31', { ...open, monthClosed: true }))).toBe('MONTH_CLOSED');
  });

  it('adds up the day report in exact money', () => {
    const report = dayReport(figures);
    expect(report.sales).toEqual({ orders: { count: 2, total: 100.1 }, pos: { count: 3, total: 0.2 }, exchanges: { count: 1 } });
    expect(report.money).toEqual({
      byMethod: [{ method: 'bank', in: 0, out: 30 }, { method: 'cash', in: 100.1, out: 0.2 }],
      totalIn: 100.1,
      totalOut: 30.2,
    });
    expect(report.cash.totalVariance).toBe(0.2);
    expect(report.cash.sessions[0]).toEqual({ id: 1, zNumber: 'Z-1', staffName: 'A', expected: 10.1, counted: 10, variance: -0.1 });
  });
});

describe('closing a month', () => {
  it('has ended once its last day has passed', () => {
    expect(monthEnded('2026-09', '2026-10-01')).toBe(true);
    expect(monthEnded('2026-10', '2026-10-31')).toBe(false);
    expect(monthEnded('2026-11', '2026-10-31')).toBe(false);
    expect(monthEnded('2025-12', '2026-01-01')).toBe(true);
  });

  it('waits for the days the branches worked, and closes once', () => {
    expect(code(() => checkMonthClosable('2026-10', '2026-10-31', { closed: false, openDays: [] }))).toBe('MONTH_NOT_ENDED');
    expect(code(() => checkMonthClosable('2026-09', '2026-10-31', { closed: true, openDays: [] }))).toBe('MONTH_ALREADY_CLOSED');
    expect(code(() => checkMonthClosable('2026-09', '2026-10-31', { closed: false, openDays: [{ branchId: 1, branchName: 'A', days: ['2026-09-03'] }] }))).toBe('MONTH_HAS_OPEN_DAYS');
    expect(code(() => checkMonthClosable('2026-09', '2026-10-31', { closed: false, openDays: [] }))).toBeUndefined();
  });

  it('sums each branch\'s days and the shop\'s total', () => {
    const summary = monthSummary([closedDay(2, 'B'), closedDay(1, 'A'), closedDay(2, 'B', { pos: { count: 1, total: '0.10' } })]);
    expect(summary.branches.map((b) => [b.branchName, b.days, b.sales])).toEqual([
      ['A', 1, 100.3],
      ['B', 2, 200.5],
    ]);
    expect(summary.totals).toEqual({ days: 3, sales: 300.8, moneyIn: 300.3, moneyOut: 90.6, refunded: 0.6, cashVariance: 0.6 });
  });
});

describe('reopening and changing in place', () => {
  it('reopens only what is closed; a day of a closed month waits for the month', () => {
    expect(code(() => checkReopenable('closed', 'day'))).toBeUndefined();
    expect(code(() => checkReopenable('reopened', 'day'))).toBe('DAY_NOT_CLOSED');
    expect(code(() => checkReopenable('reopened', 'month'))).toBe('MONTH_NOT_CLOSED');
    expect(code(() => checkMonthOpenForDay(true, '2026-09-03'))).toBe('MONTH_CLOSED');
    expect(code(() => checkMonthOpenForDay(false, '2026-09-03'))).toBeUndefined();
  });

  it('changes a record only while its day and month are open', () => {
    expect(code(() => checkChangeable(null, 'This payment'))).toBeUndefined();
    expect(code(() => checkChangeable('day', 'This payment'))).toBe('DAY_CLOSED');
    expect(code(() => checkChangeable('month', 'This payment'))).toBe('MONTH_CLOSED');
  });
});
