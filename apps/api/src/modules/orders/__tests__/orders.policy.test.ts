import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  checkCancelReturn,
  computeOrderAllowedActions,
  amountToInvoice,
  checkCanCancel,
  checkCanConfirm,
  checkCanDelete,
  checkCanDeliver,
  checkCanFulfill,
  deliveryLines,
  checkDueDate,
  checkNewOrder,
  checkQuantity,
  checkStoreCredit,
  confirmPaymentMethod,
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

describe('cancelling an order that took payments (#167)', () => {
  const seller = ['CREATE_SALE', 'PROCESS_PAYMENT'] as const;
  const refunder = ['CREATE_SALE', 'PROCESS_PAYMENT', 'PROCESS_REFUND'] as const;
  const finance = ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS'] as const;

  it('leaves an unpaid order to whoever sells, and one that took payments to whoever refunds', () => {
    expect(() => checkCancelReturn(Money.of(0), [...seller], undefined, false)).not.toThrow();
    expect(() => checkCancelReturn(Money.of(5), [...seller], 'original', true)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => checkCancelReturn(Money.of(5), [...refunder], 'original', false)).not.toThrow();
  });

  it('keeps cancelling to the selling roles: refunding alone does not cancel an order (was: Finance_Officer could)', () => {
    expect(() => checkCancelReturn(Money.of(5), [...finance], 'original', true)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => checkCancelReturn(Money.of(0), [...finance], undefined, true)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(computeOrderAllowedActions('CONFIRMED', [...finance], 'paid', 'cash_sale', 12.99)).toEqual(['deliver', 'fulfill']);
  });

  it('asks how the money goes back; store credit needs a customer', () => {
    expect(() => checkCancelReturn(Money.of(5), [...refunder], undefined, true)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => checkCancelReturn(Money.of(5), [...refunder], 'store_credit', false)).toThrow(expect.objectContaining({ code: 'CREDIT_REQUIRES_CUSTOMER' }));
    expect(() => checkCancelReturn(Money.of(5), [...refunder], 'store_credit', true)).not.toThrow();
  });

  it('offers Cancel on an order that took payments only to whoever refunds', () => {
    expect(computeOrderAllowedActions('CONFIRMED', [...seller], 'paid', 'cash_sale', 12.99)).toEqual(['deliver', 'fulfill']);
    expect(computeOrderAllowedActions('CONFIRMED', [...refunder], 'paid', 'cash_sale', 12.99)).toEqual(['cancel', 'deliver', 'fulfill']);
    expect(computeOrderAllowedActions('CONFIRMED', [...seller], 'unpaid', 'credit_sale', 0)).toEqual(['cancel', 'deliver', 'fulfill']);
  });
});

describe('delivering in parts (#174)', () => {
  const lines = [
    { id: '1', bookTitle: 'A', qtyReserved: 3 },
    { id: '2', bookTitle: 'B', qtyReserved: 0 },
  ];

  it('hands over what is named, at most what is waiting, or with nothing named everything waiting', () => {
    expect(deliveryLines(lines, [{ lineId: 1, quantity: 2 }])).toEqual([{ lineId: '1', quantity: 2 }]);
    expect(deliveryLines(lines, undefined)).toEqual([{ lineId: '1', quantity: 3 }]);
    expect(() => deliveryLines(lines, [{ lineId: 2, quantity: 1 }])).toThrow(expect.objectContaining({ code: 'DELIVERY_EXCEEDS_REMAINING' }));
    expect(() => deliveryLines(lines, [{ lineId: 9, quantity: 1 }])).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => deliveryLines([{ id: '1', bookTitle: 'A', qtyReserved: 0 }], undefined)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('keeps delivering a part-delivered order, which is not cancelled and returns what it handed over', () => {
    expect(() => checkCanDeliver('PART_DELIVERED')).not.toThrow();
    expect(() => checkCanDeliver('CONFIRMED')).not.toThrow();
    expect(() => checkCanDeliver('COMPLETED')).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => checkCanCancel('PART_DELIVERED')).toThrow(expect.objectContaining({ code: 'ORDER_PART_DELIVERED' }));
    expect(computeOrderAllowedActions('PART_DELIVERED', ['CREATE_SALE', 'PROCESS_PAYMENT'], 'paid', 'cash_sale', 10, false)).toEqual(['deliver', 'return']);
    expect(computeOrderAllowedActions('PART_DELIVERED', ['PROCESS_PAYMENT'], 'paid', 'cash_sale', 10)).toEqual(['deliver', 'fulfill']);
  });
});
