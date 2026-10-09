import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  averageCostAfterReceipt,
  canIssue,
  checkAdjustmentDirection,
  checkVersion,
  isActiveFilter,
  quantityAfterAdjustment,
  statusesFor,
  stockAlert,
} from '../inventory.policy.js';

describe('statusesFor', () => {
  it('maps the list filter to lifecycle statuses', () => {
    expect(statusesFor('active')).toEqual(['ACTIVE']);
    expect(statusesFor('inactive')).toEqual(['INACTIVE']);
    expect(statusesFor('archived')).toEqual(['ARCHIVED']);
    expect(statusesFor('all')).toBeUndefined();
  });
});

describe('isActiveFilter', () => {
  it('shows active books unless asked for others', () => {
    expect(isActiveFilter(undefined)).toBe(true);
    expect(isActiveFilter('true')).toBe(true);
    expect(isActiveFilter('false')).toBe(false);
    expect(isActiveFilter('all')).toBeUndefined();
  });
});

describe('checkVersion', () => {
  it('accepts the current version and refuses a stale one', () => {
    expect(() => checkVersion(3, 3)).not.toThrow();
    expect(() => checkVersion(3, 2)).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT', statusCode: 409 }));
  });
});

describe('checkAdjustmentDirection', () => {
  it('lets damage and loss only reduce stock', () => {
    for (const reason of ['damage', 'loss'] as const) {
      expect(() => checkAdjustmentDirection(reason, -1)).not.toThrow();
      expect(() => checkAdjustmentDirection(reason, 1)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
  });

  it('lets a return only add stock', () => {
    expect(() => checkAdjustmentDirection('return', 1)).not.toThrow();
    expect(() => checkAdjustmentDirection('return', -1)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('lets a correction go either way', () => {
    expect(() => checkAdjustmentDirection('correction', 1)).not.toThrow();
    expect(() => checkAdjustmentDirection('correction', -1)).not.toThrow();
  });
});

describe('quantityAfterAdjustment', () => {
  it('adds the change, down to zero but not below while negative stock is not allowed', () => {
    expect(quantityAfterAdjustment(5, 2, false)).toBe(7);
    expect(quantityAfterAdjustment(5, -5, false)).toBe(0);
    expect(() => quantityAfterAdjustment(5, -6, false)).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }));
  });

  it('goes below zero when negative stock is allowed, instead of stopping at zero', () => {
    expect(quantityAfterAdjustment(5, -6, true)).toBe(-1);
  });
});

describe('canIssue', () => {
  it('needs enough stock unless negative stock is allowed', () => {
    expect(canIssue(3, 3, false)).toBe(true);
    expect(canIssue(2, 3, false)).toBe(false);
    expect(canIssue(2, 3, true)).toBe(true);
  });
});

describe('averageCostAfterReceipt', () => {
  it('weighs the stock on hand and the receipt by quantity', () => {
    // 10 at 20.00 and 30 at 40.00 -> 1400 / 40 = 35.00
    expect(averageCostAfterReceipt(10, Money.of('20'), 30, Money.of('40')).toFixed(4)).toBe('35.0000');
  });

  it('keeps four decimals', () => {
    // 3 at 10.00 and 4 at 11.00 -> 74 / 7 = 10.571428...
    expect(averageCostAfterReceipt(3, Money.of('10'), 4, Money.of('11')).toFixed(4)).toBe('10.5714');
  });

  it('takes the receipt\'s cost when the shelf is empty or below zero', () => {
    expect(averageCostAfterReceipt(0, Money.of('20'), 5, Money.of('12.5')).toFixed(4)).toBe('12.5000');
    expect(averageCostAfterReceipt(-3, Money.of('20'), 5, Money.of('12.5')).toFixed(4)).toBe('12.5000');
  });
});

describe('stockAlert', () => {
  it('alerts when stock falls to or below the reorder point', () => {
    expect(stockAlert(4, 3, 3)).toBe('inventory.low_stock');
    expect(stockAlert(10, 1, 3)).toBe('inventory.low_stock');
  });

  it('does not alert again while stock stays low', () => {
    expect(stockAlert(3, 2, 3)).toBeNull();
    expect(stockAlert(2, 4, 5)).toBeNull();
  });

  it('alerts when stock runs out, once', () => {
    expect(stockAlert(2, 0, 3)).toBe('inventory.out_of_stock');
    expect(stockAlert(10, 0, 3)).toBe('inventory.out_of_stock');
    expect(stockAlert(0, 0, 3)).toBeNull();
  });

  it('does not alert above the reorder point', () => {
    expect(stockAlert(10, 8, 3)).toBeNull();
    expect(stockAlert(2, 8, 3)).toBeNull();
  });
});
