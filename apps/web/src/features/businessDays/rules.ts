import type { BusinessPeriodStatus, ProfileResponse } from '@bms/shared';

/** Names and rules of closing days and months (#175) on screen; the API decides, these only choose what to offer. */

export const PERIOD_STATUS_LABELS: Record<BusinessPeriodStatus, string> = { open: 'Open', closed: 'Closed', reopened: 'Reopened' };

export const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash', bank: 'Bank', mobile: 'Telebirr', cheque: 'Cheque', store_credit: 'Store credit', loyalty_points: 'Loyalty points',
};

export const STOCK_REASON_LABELS: Record<string, string> = {
  sale: 'Sale', return: 'Return', initial: 'Stock in', correction: 'Correction', count: 'Stock count', damage: 'Damaged',
  damage_repaired: 'Repaired', damage_write_off: 'Damage written off', loss: 'Loss', supplier_return: 'Returned to supplier',
  transfer_in: 'Transfer in', transfer_out: 'Transfer out', transfer_returned: 'Transfer returned', revaluation: 'Revaluation',
};

const holds = (me: ProfileResponse | undefined, roles: string[]) => (me?.currentRoles ?? []).some((r) => roles.includes(r));

/** Closing a branch's day: Admin, Manager, Finance_Officer (CLOSE_DAY, decision 2a). */
export const canCloseDay = (me: ProfileResponse | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer']);

/** Closing the shop's month: Admin, Finance_Officer (CLOSE_MONTH, decision 4a). */
export const canCloseMonth = (me: ProfileResponse | undefined) => holds(me, ['Admin', 'Finance_Officer']);

/** Reopening a day or a month: Admin only (REOPEN_PERIOD, decision 5a). */
export const canReopen = (me: ProfileResponse | undefined) => holds(me, ['Admin']);

/** Every date of a month (YYYY-MM), as YYYY-MM-DD. */
export function daysOf(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** The months of a year, as YYYY-MM. */
export const monthsOf = (year: number): string[] => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

/** The weekday a date falls on, Monday first (0–6), to place the first day in the calendar. */
export const weekdayOf = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Over when positive, short when negative. */
export function varianceLabel(variance: number, format: (n: number) => string): string {
  if (variance === 0) return 'Even';
  return `${variance > 0 ? 'Over' : 'Short'} ${format(Math.abs(variance))}`;
}
