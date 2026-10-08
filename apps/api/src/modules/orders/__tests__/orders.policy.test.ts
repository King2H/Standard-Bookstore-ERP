import { describe, it, expect } from 'vitest';
import {
  amountToInvoice,
  applyPayment,
  checkCanCancel,
  checkCanCollectPayment,
  checkCanConfirm,
  checkCanDelete,
  checkCanFulfill,
  checkDueDate,
  checkNewOrder,
  checkPaymentAmount,
  checkQuantity,
  checkStoreCredit,
  confirmPaymentMethod,
  dailyNumber,
  normaliseStatus,
  orderTotals,
  priceLine,
} from '../orders.policy.js';

const code = (c: string) => expect.objectContaining({ code: c });

describe('order lifecycle', () => {
  it('reads pre-migration status names as the new ones', () => {
    expect(normaliseStatus('Pending')).toBe('DRAFT');
    expect(normaliseStatus('In_Progress')).toBe('CONFIRMED');
    expect(normaliseStatus('PAID')).toBe('PAID');
  });

  it('confirms only drafts', () => {
    expect(() => checkCanConfirm('DRAFT')).not.toThrow();
    expect(() => checkCanConfirm('Pending')).not.toThrow();
    expect(() => checkCanConfirm('CONFIRMED')).toThrow(code('INVALID_STATE'));
  });

  it('fulfils any confirmed order, whatever its payment state', () => {
    for (const status of ['CONFIRMED', 'PARTIALLY_PAID', 'PAID', 'Confirmed', 'In_Progress']) {
      expect(() => checkCanFulfill(status)).not.toThrow();
    }
    expect(() => checkCanFulfill('DRAFT')).toThrow(code('INVALID_STATE'));
  });

  it('cancels before fulfilment, restoring stock only once confirm has taken it out', () => {
    expect(checkCanCancel('DRAFT')).toEqual({ restoresStock: false });
    expect(checkCanCancel('CONFIRMED')).toEqual({ restoresStock: true });
    expect(checkCanCancel('PAID')).toEqual({ restoresStock: true });
    expect(() => checkCanCancel('COMPLETED')).toThrow(code('ORDER_ALREADY_FULFILLED'));
    expect(() => checkCanCancel('Cancelled')).toThrow(code('ALREADY_CANCELLED'));
  });

  it('deletes only drafts and cancelled orders without history', () => {
    const draft = { status: 'DRAFT', orderNumber: 'ORD-1' };
    expect(() => checkCanDelete(draft, [])).not.toThrow();
    expect(() => checkCanDelete({ ...draft, status: 'CONFIRMED' }, [])).toThrow(code('INVALID_STATE'));
    expect(() => checkCanDelete(draft, ['payments'])).toThrow(
      expect.objectContaining({ code: 'ORDER_HAS_DEPENDENCIES', details: { blockers: ['payments'] } }),
    );
  });

  it('collects payment only on fulfilled credit orders', () => {
    expect(() => checkPaymentAmount(0)).toThrow(code('VALIDATION_ERROR'));
    expect(() => checkCanCollectPayment({ status: 'COMPLETED', saleType: 'credit_sale' })).not.toThrow();
    expect(() => checkCanCollectPayment({ status: 'CANCELLED', saleType: 'credit_sale' })).toThrow(code('ORDER_CANCELLED'));
    expect(() => checkCanCollectPayment({ status: 'CONFIRMED', saleType: 'credit_sale' })).toThrow(code('INVALID_STATE'));
    expect(() => checkCanCollectPayment({ status: 'COMPLETED', saleType: 'cash_sale' })).toThrow(code('INVALID_STATE'));
  });
});

describe('creating an order', () => {
  it('needs items, and a customer for credit sales', () => {
    expect(() => checkNewOrder({ saleType: 'cash_sale', items: [] })).toThrow(code('VALIDATION_ERROR'));
    expect(() => checkNewOrder({ saleType: 'credit_sale', items: [{ bookId: 1, quantity: 1 }] })).toThrow(
      code('CREDIT_REQUIRES_CUSTOMER'),
    );
  });

  it('needs a positive whole quantity', () => {
    expect(() => checkQuantity({ bookId: 1, quantity: 1.5 })).toThrow(code('VALIDATION_ERROR'));
    expect(() => checkQuantity({ bookId: 1, quantity: 0 })).toThrow(code('VALIDATION_ERROR'));
  });

  it('prices lines exactly, without floating-point drift', () => {
    // 19.99 x 3 is 59.97000000000001 in floating point.
    const line = priceLine({ bookId: 1, quantity: 3 }, 19.99, 100);
    expect(line).toMatchObject({ unitPrice: '19.99', discountAmount: '0.00', totalPrice: '59.97', discountMode: 'Amount' });
  });

  it('applies a percentage discount through the discount engine, within the cap', () => {
    const line = priceLine({ bookId: 1, quantity: 2, discountMode: 'Percentage', discountPct: 10 }, 150, 20);
    expect(line).toMatchObject({ discountAmount: '30.00', discountPct: 10, totalPrice: '270.00' });
    expect(() => priceLine({ bookId: 1, quantity: 1, discountPct: 25 }, 100, 20)).toThrow(code('DISCOUNT_EXCEEDS_LIMIT'));
  });

  it('keeps the legacy plain discount, never below zero', () => {
    expect(priceLine({ bookId: 1, quantity: 4, discountAmount: 10 }, 50, 0)).toMatchObject({
      discountAmount: '10.00', discountPct: 5, totalPrice: '190.00',
    });
    expect(priceLine({ bookId: 1, quantity: 1, discountAmount: -5 }, 50, 0)).toMatchObject({ discountAmount: '0.00', totalPrice: '50.00' });
  });

  it('totals the lines, with no tax yet', () => {
    const lines = [priceLine({ bookId: 1, quantity: 1 }, 0.1, 0), priceLine({ bookId: 2, quantity: 1 }, 0.2, 0)];
    expect(orderTotals(lines)).toEqual({ subtotal: '0.30', discountTotal: '0.00', taxRate: '0.0000', taxAmount: '0.00', total: '0.30' });
  });

  it('numbers records per day', () => {
    expect(dailyNumber('ORD', '20261008', 41)).toBe('ORD-20261008-0042');
  });
});

describe('confirming an order', () => {
  const credit = { saleType: 'credit_sale' as const, customerId: 7 };
  const cash = { saleType: 'cash_sale' as const, customerId: null };

  it('requires a due date, today or later, for credit orders', () => {
    expect(() => checkDueDate(credit, undefined, '2026-10-08')).toThrow(code('VALIDATION_ERROR'));
    expect(() => checkDueDate(credit, '08/10/2026', '2026-10-08')).toThrow(code('VALIDATION_ERROR'));
    expect(() => checkDueDate(credit, '2026-10-07', '2026-10-08')).toThrow(code('VALIDATION_ERROR'));
    expect(() => checkDueDate(credit, '2026-10-08', '2026-10-08')).not.toThrow();
    expect(() => checkDueDate(cash, undefined, '2026-10-08')).not.toThrow();
  });

  it('records a payment method for cash orders only, cash by default', () => {
    expect(confirmPaymentMethod(cash, undefined)).toBe('cash');
    expect(confirmPaymentMethod(cash, 'mobile')).toBe('mobile');
    expect(confirmPaymentMethod(credit, 'mobile')).toBeNull();
    expect(() => confirmPaymentMethod(cash, 'cheque')).toThrow(code('VALIDATION_ERROR'));
    expect(() => confirmPaymentMethod(cash, 'store_credit')).toThrow(code('STORE_CREDIT_REQUIRES_CUSTOMER'));
  });

  it('needs enough store credit, within 0.01', () => {
    expect(() => checkStoreCredit('99.99', 100)).not.toThrow();
    expect(() => checkStoreCredit('99.98', 100)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_STORE_CREDIT', details: { available: 99.98, requested: 100 } }),
    );
    expect(() => checkStoreCredit(null, 1)).toThrow(code('INSUFFICIENT_STORE_CREDIT'));
  });

  it('invoices what a credit order still owes, if more than 0.01', () => {
    expect(amountToInvoice(100, '30.00')?.toFixed()).toBe('70.00');
    expect(amountToInvoice(100, '99.99')).toBeNull();
  });
});

describe('collecting a credit payment', () => {
  it('reduces the outstanding amount, never below zero', () => {
    const partial = applyPayment('100.00', 40);
    expect([partial.newOutstanding.toFixed(), partial.isFullySettled, partial.paymentStatus]).toEqual(['60.00', false, 'partial']);
    const full = applyPayment('0.30', 0.3);
    expect([full.newOutstanding.toFixed(), full.isFullySettled, full.paymentStatus]).toEqual(['0.00', true, 'paid']);
    expect(applyPayment('10.00', 25).newOutstanding.toFixed()).toBe('0.00');
  });
});
