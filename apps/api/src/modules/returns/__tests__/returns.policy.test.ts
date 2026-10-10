import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  allocateRefund,
  checkApproval,
  checkSale,
  lineValue,
  pointsToTakeBack,
  refundMethodOf,
  saleAfterCredit,
  storeCreditOnly,
} from '../returns.policy.js';
import type { SaleForReturn, SaleLine, Tender } from '../returns.types.js';

const sale: SaleForReturn = {
  id: '1',
  branchId: 1,
  locationId: 1,
  customerId: 7,
  status: 'completed',
  transactionNumber: 'POS-20261010-0001',
  subtotal: Money.of(100),
  grandTotal: Money.of(100),
  amountPaid: Money.of(100),
  amountDue: Money.ZERO,
  daysSinceSale: 0,
};

const line: SaleLine = {
  id: '1',
  bookId: 1,
  quantity: 3,
  unitPrice: Money.of('10.00'),
  lineTotal: Money.of('29.00'),
  unitCost: null,
  returnedQuantity: 0,
  returnedValue: Money.ZERO,
};

const tender = (method: Tender['method'], available: number, at: number): Tender => ({
  method,
  available: Money.of(available),
  lastPaidAt: new Date(at),
});

describe('checkSale', () => {
  it("treats another branch's sale as not found, and refuses a voided one", () => {
    expect(() => checkSale(sale, 2)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => checkSale({ ...sale, status: 'voided' }, 1)).toThrow(expect.objectContaining({ code: 'TRANSACTION_VOIDED' }));
    expect(() => checkSale(sale, 1)).not.toThrow();
  });
});

describe('lineValue', () => {
  it('prorates what the line cost after its discount; the last units take the rest', () => {
    expect(lineValue(line, 1).toFixed()).toBe('9.67');
    const afterOne = { ...line, returnedQuantity: 1, returnedValue: Money.of('9.67') };
    expect(lineValue(afterOne, 2).toFixed()).toBe('19.33');
    expect(lineValue(line, 3).toFixed()).toBe('29.00');
  });

  it('refuses more than is left of the line', () => {
    expect(() => lineValue({ ...line, returnedQuantity: 2 }, 2)).toThrow(expect.objectContaining({ code: 'OVER_RETURN' }));
  });
});

describe('checkApproval', () => {
  it('above the limit, needs a Manager or Admin', () => {
    expect(() => checkApproval(Money.of(501), Money.of(500), 'Sales')).toThrow(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(checkApproval(Money.of(501), Money.of(500), 'Manager')).toBe(true);
    expect(checkApproval(Money.of(500), Money.of(500), 'Sales')).toBe(false);
  });
});

describe('allocateRefund', () => {
  const opts = { storeCreditOnly: false, hasCustomer: true, paidLeft: Money.of(100) };

  it('gives back the newest payment method first, each up to what it has left', () => {
    const parts = allocateRefund(Money.of(60), [tender('cash', 50, 1), tender('mobile', 30, 2)], opts);
    expect(parts.map((p) => [p.method, p.amount.toFixed()])).toEqual([['mobile', '30.00'], ['cash', '30.00']]);
  });

  it('refuses more than is left of what was paid', () => {
    expect(() => allocateRefund(Money.of(101), [tender('cash', 100, 1)], opts)).toThrow(expect.objectContaining({ code: 'REFUND_EXCEEDS_PAID' }));
  });

  it('after the window may give store credit only, which needs a customer', () => {
    const only = { ...opts, storeCreditOnly: true };
    expect(allocateRefund(Money.of(10), [tender('cash', 100, 1)], only)).toEqual([{ method: 'store_credit', amount: Money.of(10) }]);
    expect(() => allocateRefund(Money.of(10), [tender('cash', 100, 1)], { ...only, hasCustomer: false })).toThrow(
      expect.objectContaining({ code: 'STORE_CREDIT_REQUIRES_CUSTOMER' }),
    );
  });

  it('gives nothing back for nothing', () => {
    expect(allocateRefund(Money.ZERO, [], opts)).toEqual([]);
  });
});

describe('refundMethodOf', () => {
  it('names the one method, or mixed', () => {
    expect(refundMethodOf([{ method: 'cash', amount: Money.of(1) }])).toBe('cash');
    expect(refundMethodOf([{ method: 'credit_note', amount: Money.of(1) }, { method: 'cash', amount: Money.of(1) }])).toBe('mixed');
  });
});

describe('saleAfterCredit', () => {
  it('takes the credit off what is due', () => {
    expect(saleAfterCredit({ amountPaid: Money.ZERO, amountDue: Money.of(50) }, Money.of(20))).toEqual({ due: Money.of(30), status: 'credit' });
    expect(saleAfterCredit({ amountPaid: Money.of(10), amountDue: Money.of(50) }, Money.of(20)).status).toBe('partial');
    expect(saleAfterCredit({ amountPaid: Money.ZERO, amountDue: Money.of(50) }, Money.of(50))).toEqual({ due: Money.ZERO, status: 'paid' });
  });
});

describe('storeCreditOnly', () => {
  it('applies after the window, when the policy says so', () => {
    expect(storeCreditOnly(31, 30, 'store_credit_only')).toBe(true);
    expect(storeCreditOnly(30, 30, 'store_credit_only')).toBe(false);
    expect(storeCreditOnly(31, 30, 'any')).toBe(false);
  });
});

describe('pointsToTakeBack', () => {
  it('takes back the returned share of the points, less what was taken already', () => {
    const base = { earned: 10, reversed: 0, grandTotal: Money.of(100) };
    expect(pointsToTakeBack({ ...base, returnedValue: Money.of(33) })).toBe(3);
    expect(pointsToTakeBack({ ...base, reversed: 3, returnedValue: Money.of(100) })).toBe(7);
    expect(pointsToTakeBack({ ...base, earned: 0, returnedValue: Money.of(100) })).toBe(0);
  });
});
