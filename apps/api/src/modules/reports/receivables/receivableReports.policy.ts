import { Money, type AgingBucket } from '@bms/shared';

/** Pure rules of the receivables reports (A5). */

export const AGING_BUCKETS: AgingBucket[] = ['Current', '1-30', '31-60', '61-90', '90+'];

/** The bucket for days past the due date (0 or less, or no due date: Current). */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'Current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

/** Count and amount outstanding per bucket, every bucket listed. */
export function byBucket(rows: Array<{ agingBucket: AgingBucket; outstandingAmount: number }>) {
  return AGING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((r) => r.agingBucket === bucket);
    return { bucket, count: inBucket.length, totalOutstanding: Money.sum(inBucket.map((r) => r.outstandingAmount)).toNumber() };
  });
}
