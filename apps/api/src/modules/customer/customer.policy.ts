import { Money, type LifecycleStatus, type MoneyInput } from '@bms/shared';
import { BusinessError, ValidationError } from '../../lib/errors.js';

/**
 * Customer rules as pure functions (A5): no I/O, so they are unit-tested
 * without a database (__tests__/customer.policy.test.ts).
 */

/** `?status=` on the list: active (the default), inactive, archived, or all (undefined). */
export function statusesFor(status: 'active' | 'inactive' | 'archived' | 'all'): LifecycleStatus[] | undefined {
  if (status === 'all') return undefined;
  if (status === 'inactive') return ['INACTIVE'];
  if (status === 'archived') return ['ARCHIVED'];
  return ['ACTIVE'];
}

/** The next code after the highest CUS-nnnn so far: CUS-0001, CUS-0002, ... */
export function nextCustomerCode(highest: number): string {
  return `CUS-${String(highest + 1).padStart(4, '0')}`;
}

/** A store-credit adjustment must move a positive amount; the direction says which way. */
export function checkAdjustmentAmount(amount: MoneyInput): Money {
  const money = Money.of(amount);
  if (money.isNegative() || money.isZero()) {
    throw new ValidationError('Amount must be more than zero', { field: 'amount' });
  }
  return money;
}

export function checkEnoughPoints(balance: number, points: number): void {
  if (balance < points) {
    throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Insufficient loyalty points balance', {
      available: balance,
      requested: points,
    });
  }
}

export function checkEnoughStoreCredit(balance: Money, amount: Money): void {
  if (balance.lessThan(amount)) {
    throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Insufficient store credit balance', {
      available: balance.toNumber(),
      requested: amount.toNumber(),
    });
  }
}

/** Points earned on a sale: floor(amount × rate), nothing below the minimum amount. */
export function pointsEarned(amount: MoneyInput, rate: number, minAmount: MoneyInput): number {
  const money = Money.of(amount);
  if (money.lessThan(minAmount)) return 0;
  return Math.max(0, Math.floor(money.times(rate).toNumber(4)));
}
