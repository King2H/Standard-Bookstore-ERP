import { Money } from '@bms/shared';
import { BusinessError } from '../../lib/errors.js';
import type { StockCountLineRecord, StockCountStatus } from './stockCounts.types.js';

/**
 * Rules of stock counts (A5), pure (#172, owner decisions 1a–6a,
 * 2026-10-30): which status allows what, who sees what is expected, and what
 * the differences are worth.
 */

export function checkStatus(status: StockCountStatus, allowed: StockCountStatus[], action: string): void {
  if (!allowed.includes(status)) {
    throw new BusinessError('STOCK_COUNT_INVALID_STATUS', `A count that is ${status} cannot be ${action}`);
  }
}

/** Admin and Manager review, recount, post and cancel (APPROVE_STOCK_COUNT). */
export const isReviewer = (roles: readonly string[]): boolean => roles.some((r) => r === 'Admin' || r === 'Manager');

/** The count is blind (decision 3a): a counter sees no expected quantity until it is posted or cancelled. */
export const isBlind = (status: StockCountStatus, roles: readonly string[]): boolean =>
  (status === 'counting' || status === 'submitted') && !isReviewer(roles);

/** Counted less expected; null until counted. */
export const difference = (line: Pick<StockCountLineRecord, 'countedQuantity' | 'expectedQuantity'>): number | null =>
  line.countedQuantity === null || line.expectedQuantity === null ? null : line.countedQuantity - line.expectedQuantity;

/** A line's difference at the cost it was posted at, or the location's average cost until then. */
export function differenceValue(line: StockCountLineRecord): Money | null {
  const diff = difference(line);
  if (diff === null) return null;
  return (line.postedUnitCost ?? line.averageCost).times(diff).round(2);
}

/** Copies over and short, and their value (decision 4a). */
export function totals(lines: StockCountLineRecord[]) {
  let overQuantity = 0;
  let shortQuantity = 0;
  let overValue = Money.ZERO;
  let shortValue = Money.ZERO;
  for (const line of lines) {
    const diff = difference(line);
    const value = differenceValue(line);
    if (diff === null || value === null) continue;
    if (diff > 0) { overQuantity += diff; overValue = overValue.plus(value); }
    if (diff < 0) { shortQuantity -= diff; shortValue = shortValue.minus(value); }
  }
  return { overQuantity, shortQuantity, overValue, shortValue };
}
