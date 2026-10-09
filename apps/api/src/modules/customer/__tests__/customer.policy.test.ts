import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  checkAdjustmentAmount,
  checkEnoughPoints,
  checkEnoughStoreCredit,
  nextCustomerCode,
  pointsEarned,
  statusesFor,
} from '../customer.policy.js';

describe('statusesFor', () => {
  it('maps the list filter to lifecycle statuses', () => {
    expect(statusesFor('active')).toEqual(['ACTIVE']);
    expect(statusesFor('inactive')).toEqual(['INACTIVE']);
    expect(statusesFor('archived')).toEqual(['ARCHIVED']);
    expect(statusesFor('all')).toBeUndefined();
  });
});

describe('nextCustomerCode', () => {
  it('numbers codes from CUS-0001', () => {
    expect(nextCustomerCode(0)).toBe('CUS-0001');
    expect(nextCustomerCode(41)).toBe('CUS-0042');
    expect(nextCustomerCode(12345)).toBe('CUS-12346');
  });
});

describe('checkAdjustmentAmount', () => {
  it('accepts a positive amount as Money', () => {
    expect(checkAdjustmentAmount('12.50').toFixed(2)).toBe('12.50');
  });

  it('refuses zero and negative amounts (was: a negative credit reached the database)', () => {
    for (const amount of [0, '0.00', -250, '-0.01']) {
      expect(() => checkAdjustmentAmount(amount)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    }
  });
});

describe('balance checks', () => {
  it('refuses taking more points or store credit than the customer has', () => {
    expect(() => checkEnoughPoints(10, 10)).not.toThrow();
    expect(() => checkEnoughPoints(10, 11)).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_LOYALTY_POINTS' }));
    expect(() => checkEnoughStoreCredit(Money.of('5.00'), Money.of('5.00'))).not.toThrow();
    expect(() => checkEnoughStoreCredit(Money.of('5.00'), Money.of('5.01'))).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_STORE_CREDIT' }),
    );
  });
});

describe('pointsEarned', () => {
  it('is floor(amount × rate), nothing below the minimum amount', () => {
    expect(pointsEarned('250.00', 0.01, 0)).toBe(2);
    expect(pointsEarned('99.99', 1, 100)).toBe(0);
    expect(pointsEarned('100.00', 1, 100)).toBe(100);
  });
});
