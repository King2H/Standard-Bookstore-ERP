import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import { buildLedger, checkCanReverse, checkPayable, checkWithinOrderTotal, type LedgerEvent } from '../supplierPayables.policy.js';

describe('paying', () => {
  it('pays an order once it was approved', () => {
    expect(() => checkPayable('approved')).not.toThrow();
    expect(() => checkPayable('closed')).not.toThrow();
    expect(() => checkPayable('pending_approval')).toThrow(expect.objectContaining({ code: 'PO_NOT_PAYABLE' }));
  });

  it('keeps payments and credit notes within the ordered total', () => {
    expect(() => checkWithinOrderTotal(Money.of(100), Money.of(60), Money.of(40))).not.toThrow();
    expect(() => checkWithinOrderTotal(Money.of(100), Money.of(60), Money.of('40.01'))).toThrow(
      expect.objectContaining({ code: 'EXCEEDS_ORDER_TOTAL' }),
    );
  });

  it('reverses a payment once', () => {
    expect(() => checkCanReverse({ reversedAt: null })).not.toThrow();
    expect(() => checkCanReverse({ reversedAt: new Date() })).toThrow(expect.objectContaining({ code: 'ALREADY_REVERSED' }));
  });
});

describe('buildLedger', () => {
  const event = (day: string, type: LedgerEvent['type'], amount: number): LedgerEvent => ({
    day, type, reference: type, description: type, amount: Money.of(amount),
  });
  const events = [
    event('2026-10-01', 'PO', 0),
    event('2026-10-02', 'GOODS_RECEIPT', 100),
    event('2026-10-03', 'PAYMENT', -60),
    event('2026-10-04', 'CREDIT_NOTE', -10),
  ];

  it('carries the running balance into the dates shown', () => {
    const { entries, currentBalance } = buildLedger(events, { dateFrom: '2026-10-03', dateTo: '2026-10-03' });
    expect(entries.map((e) => [e.type, e.balance.toFixed()])).toEqual([['PAYMENT', '40.00']]);
    expect(currentBalance.toFixed()).toBe('30.00');
  });
});
