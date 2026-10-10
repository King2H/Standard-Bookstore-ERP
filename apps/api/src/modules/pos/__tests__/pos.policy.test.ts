import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import { amountDue, checkCanVoid, checkDiscounts, checkSalePayments, checkTender, isVoidable, paymentStatus, priceLine } from '../pos.policy.js';

const sold = { status: 'completed' as const, soldOn: '2026-10-10', today: '2026-10-10', hasReturns: false };

describe('priceLine and checkDiscounts', () => {
  it('discounts by percentage, or by an amount no larger than the line', () => {
    const pct = priceLine({ bookId: 1, quantity: 2, discountPct: 10, discountMode: 'Percentage' }, Money.of('50'));
    expect([pct.discountAmount.toFixed(), pct.lineTotal.toFixed()]).toEqual(['10.00', '90.00']);
    const amount = priceLine({ bookId: 1, quantity: 1, discountPct: 0, discountAmount: 80, discountMode: 'Amount' }, Money.of('50'));
    expect([amount.discountAmount.toFixed(), amount.lineTotal.toFixed()]).toEqual(['50.00', '0.00']);
  });

  it('holds an amount discount to the role\'s maximum percentage', () => {
    const line = priceLine({ bookId: 1, quantity: 1, discountPct: 0, discountAmount: 6, discountMode: 'Amount' }, Money.of('50'));
    expect(() => checkDiscounts([line], 12)).not.toThrow();
    expect(() => checkDiscounts([line], 10)).toThrow(expect.objectContaining({ code: 'DISCOUNT_EXCEEDS_LIMIT' }));
  });
});

describe('payments', () => {
  it('needs a customer for store credit and loyalty points', () => {
    const credit = [{ method: 'store_credit' as const, amount: Money.of(1), reference: null }];
    expect(() => checkTender(credit, null)).toThrow(expect.objectContaining({ code: 'STORE_CREDIT_REQUIRES_CUSTOMER' }));
    expect(() => checkTender(credit, 7)).not.toThrow();
  });

  it('takes a cent of till rounding as paid, with nothing left due', () => {
    expect(paymentStatus(Money.of('99.99'), Money.of('99.98'))).toBe('paid');
    expect(amountDue(Money.of('99.99'), Money.of('99.98')).toFixed()).toBe('0.00');
    expect(paymentStatus(Money.of('100'), Money.of('40'))).toBe('partial');
    expect(paymentStatus(Money.of('100'), Money.ZERO)).toBe('credit');
  });

  it('refuses a credit sale due before today', () => {
    const sale = { grandTotal: Money.of(100), paid: Money.ZERO, allowCredit: true, customerId: 7 };
    expect(() => checkSalePayments({ ...sale, dueDate: '2026-10-09' }, '2026-10-10')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => checkSalePayments({ ...sale, dueDate: '2026-10-10' }, '2026-10-10')).not.toThrow();
  });
});

describe('voiding', () => {
  it('is possible on the day of the sale while nothing was returned', () => {
    expect(isVoidable(sold)).toBe(true);
    expect(() => checkCanVoid({ ...sold, soldOn: '2026-10-09' })).toThrow(expect.objectContaining({ code: 'VOID_WINDOW_CLOSED' }));
    expect(() => checkCanVoid({ ...sold, hasReturns: true })).toThrow(expect.objectContaining({ code: 'TRANSACTION_HAS_RETURNS' }));
    expect(() => checkCanVoid({ ...sold, status: 'voided' })).toThrow(expect.objectContaining({ code: 'ALREADY_VOIDED' }));
  });
});
