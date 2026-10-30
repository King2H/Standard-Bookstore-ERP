import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import { checkStatus, difference, differenceValue, isBlind, totals } from '../stockCounts.policy.js';
import type { StockCountLineRecord } from '../stockCounts.types.js';
import { ROLE_PERMISSIONS } from '../../../lib/permissions.js';

const line = (expected: number | null, counted: number | null, cost = '4', posted?: string): StockCountLineRecord => ({
  id: 1, bookId: 1, bookTitle: 'Dune', isbn: null, frozenQuantity: 5, expectedQuantity: expected, countedQuantity: counted,
  countedBy: null, countedByName: null, countedAt: null, counts: [], recountRequested: false,
  averageCost: Money.of(cost), postedDelta: null, postedUnitCost: posted === undefined ? null : Money.of(posted),
});

describe('stock count rules (#172)', () => {
  it('is counted while counting, reviewed when submitted, and changes no more once posted or cancelled', () => {
    expect(() => checkStatus('counting', ['counting'], 'counted')).not.toThrow();
    for (const s of ['submitted', 'posted', 'cancelled'] as const) {
      expect(() => checkStatus(s, ['counting'], 'counted')).toThrow(expect.objectContaining({ code: 'STOCK_COUNT_INVALID_STATUS' }));
    }
  });

  it('is blind for a counter until posted; never for an Admin or Manager (3a)', () => {
    expect(isBlind('counting', ['Stock_Clerk'])).toBe(true);
    expect(isBlind('submitted', ['Stock_Clerk'])).toBe(true);
    expect(isBlind('posted', ['Stock_Clerk'])).toBe(false);
    expect(isBlind('counting', ['Stock_Clerk', 'Manager'])).toBe(false);
    expect(isBlind('counting', ['Admin'])).toBe(false);
  });

  it('values a difference at the average cost, or at the cost it was posted at (4a, 6a)', () => {
    expect(difference(line(null, null))).toBeNull();
    expect(difference(line(5, 3))).toBe(-2);
    expect(differenceValue(line(5, 3))!.toFixed(2)).toBe('-8.00');
    expect(differenceValue(line(5, 6, '4', '2.5'))!.toFixed(2)).toBe('2.50');
    const t = totals([line(5, 3), line(0, 2, '6'), line(4, 4), line(null, null)]);
    expect({ ...t, overValue: t.overValue.toFixed(2), shortValue: t.shortValue.toFixed(2) })
      .toEqual({ overQuantity: 2, shortQuantity: 2, overValue: '12.00', shortValue: '8.00' });
  });

  it('lets Admin and Manager approve a count', () => {
    const approvers = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.includes('APPROVE_STOCK_COUNT')).map(([r]) => r);
    expect(approvers.sort()).toEqual(['Admin', 'Manager']);
  });
});
