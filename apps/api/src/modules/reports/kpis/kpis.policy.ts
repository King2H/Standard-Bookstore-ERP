import { Money, type KpiPeriod, type MoneyInput } from '@bms/shared';

/** Pure rules of the KPIs (A5). */

export interface PeriodRange {
  dateFrom: string;
  dateTo: string;
  prevFrom: string;
  prevTo: string;
}

/**
 * The period so far and the whole previous equivalent one: today against
 * yesterday, this week, month or year to date against the previous one.
 */
export function periodRange(period: KpiPeriod, c: Record<string, string>): PeriodRange {
  switch (period) {
    case 'today':
      return { dateFrom: c.today, dateTo: c.today, prevFrom: c.yesterday, prevTo: c.yesterday };
    case 'week':
      return { dateFrom: c.week_start, dateTo: c.today, prevFrom: c.prev_week_start, prevTo: c.prev_week_end };
    case 'month':
      return { dateFrom: c.month_start, dateTo: c.today, prevFrom: c.prev_month_start, prevTo: c.prev_month_end };
    case 'year':
      return { dateFrom: c.year_start, dateTo: c.today, prevFrom: c.prev_year_start, prevTo: c.prev_year_end };
  }
}

/** The sum of database amounts, as a number rounded to cents. */
export function total(...amounts: MoneyInput[]): number {
  return Money.sum(amounts).toNumber();
}
