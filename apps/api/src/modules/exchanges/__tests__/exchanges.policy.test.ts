import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  checkApproval,
  checkCanVoid,
  checkSettlement,
  checkStoreCreditUnspent,
  checkTradeInValue,
  settlementType,
} from '../exchanges.policy.js';

const today = '2026-10-10';
const completed = { status: 'Completed', lifecycleStatus: null, madeOn: today, today, voidedAt: null };

describe('settlementType', () => {
  it('reads who owes from the difference, a cent either way being even', () => {
    expect(settlementType(Money.of(60))).toBe('Customer_Pays');
    expect(settlementType(Money.of(-60))).toBe('Store_Refunds');
    expect(settlementType(Money.of('0.01'))).toBe('Even');
  });
});

describe('valuation', () => {
  it('holds a trade-in to its selling price; an unpriced book is for a Manager or Admin', () => {
    expect(() => checkTradeInValue(1, Money.of(100), Money.of(100), 'Sales')).not.toThrow();
    expect(() => checkTradeInValue(1, Money.of('100.01'), Money.of(100), 'Admin')).toThrow(expect.objectContaining({ code: 'TRADE_IN_ABOVE_PRICE' }));
    expect(() => checkTradeInValue(1, Money.of(5), null, 'Sales')).toThrow(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(() => checkTradeInValue(1, Money.of(5), null, 'Manager')).not.toThrow();
  });

  it('needs a Manager or Admin above the approval limit', () => {
    expect(() => checkApproval(Money.of(501), Money.of(500), 'Sales')).toThrow(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(() => checkApproval(Money.of(501), Money.of(500), 'Manager')).not.toThrow();
    expect(() => checkApproval(Money.of(500), Money.of(500), 'Sales')).not.toThrow();
  });
});

describe('checkSettlement', () => {
  const base = { allowCredit: false, customerId: 7, dueDate: null, refundMethod: 'store_credit' as const };

  it('takes what the customer owes at the counter, the rest on credit only when asked', () => {
    expect(() => checkSettlement({ ...base, net: Money.of(60), paid: Money.of(60) }, today)).not.toThrow();
    expect(() => checkSettlement({ ...base, net: Money.of(60), paid: Money.of(20) }, today)).toThrow(
      expect.objectContaining({ code: 'PAYMENT_SUM_MISMATCH' }),
    );
    expect(() => checkSettlement({ ...base, net: Money.of(60), paid: Money.of(20), allowCredit: true }, today)).not.toThrow();
    expect(() => checkSettlement({ ...base, net: Money.of(60), paid: Money.ZERO, allowCredit: true, customerId: null }, today)).toThrow(
      expect.objectContaining({ code: 'CREDIT_REQUIRES_CUSTOMER' }),
    );
  });

  it('takes no payment when nothing is owed; store credit back needs a customer', () => {
    expect(() => checkSettlement({ ...base, net: Money.of(-40), paid: Money.of(1) }, today)).toThrow(
      expect.objectContaining({ code: 'PAYMENT_EXCEEDS_TOTAL' }),
    );
    expect(() => checkSettlement({ ...base, net: Money.of(-40), paid: Money.ZERO, customerId: null }, today)).toThrow(
      expect.objectContaining({ code: 'STORE_CREDIT_REQUIRES_CUSTOMER' }),
    );
    expect(() => checkSettlement({ ...base, net: Money.of(-40), paid: Money.ZERO, customerId: null, refundMethod: 'cash' }, today)).not.toThrow();
  });
});

describe('voiding', () => {
  it('voids a Quick Exchange on its day, once', () => {
    expect(() => checkCanVoid(completed)).not.toThrow();
    expect(() => checkCanVoid({ ...completed, madeOn: '2026-10-09' })).toThrow(expect.objectContaining({ code: 'VOID_WINDOW_CLOSED' }));
    expect(() => checkCanVoid({ ...completed, status: 'Cancelled', voidedAt: new Date() })).toThrow(
      expect.objectContaining({ code: 'ALREADY_VOIDED' }),
    );
    expect(() => checkCanVoid({ ...completed, lifecycleStatus: 'COMPLETED' })).toThrow(expect.objectContaining({ code: 'EXCHANGE_NOT_CANCELLABLE' }));
  });

  it('takes back store credit only while the customer has it', () => {
    expect(() => checkStoreCreditUnspent(Money.of(80), Money.of(80))).not.toThrow();
    expect(() => checkStoreCreditUnspent(Money.of(10), Money.of(80))).toThrow(expect.objectContaining({ code: 'STORE_CREDIT_SPENT' }));
  });
});
