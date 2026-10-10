import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import { checkCanPay, checkCanRefund, orderPaymentStatus, outstanding, refundBankAccount } from '../payments.policy.js';
import type { OrderForPayment, PaymentRecord } from '../payments.types.js';

const takings = (paid: string, refunded = '0') => ({ paid: Money.of(paid), refunded: Money.of(refunded) });
const order = (o: Partial<OrderForPayment> = {}): OrderForPayment => ({
  id: '1', orderNumber: 'ORD-1', branchId: 1, status: 'CONFIRMED', saleType: 'credit_sale',
  total: Money.of('100'), customerId: 7, paymentStatus: 'unpaid', ...o,
});
const payment = (p: Partial<PaymentRecord> = {}) => ({
  id: '9', paymentReference: 'PAY-1', orderId: '1', amount: Money.of('40'), currency: 'ETB', paymentMethod: 'cash',
  status: 'success', transactionReference: null, notes: null, processedAt: new Date(), createdAt: new Date(),
  processedBy: 1, bankAccountId: null, ...p,
}) as PaymentRecord;

describe('orderPaymentStatus', () => {
  it('owes a refunded credit sale again', () => {
    expect(orderPaymentStatus(order(), Money.of(100), takings('100', '100'))).toBe('unpaid');
    expect(orderPaymentStatus(order(), Money.of(100), takings('100', '30'))).toBe('partial');
  });

  it('marks a fully refunded cash sale refunded', () => {
    expect(orderPaymentStatus(order({ saleType: 'cash_sale' }), Money.of(100), takings('100', '100'))).toBe('refunded');
  });

  it('is paid at exactly the total', () => {
    expect(orderPaymentStatus(order(), Money.of(100), takings('100'))).toBe('paid');
    expect(outstanding(Money.of(100), takings('100', '25.5')).toFixed()).toBe('25.50');
  });
});

describe('checkCanPay', () => {
  it('treats another branch\'s order as not found', () => {
    expect(() => checkCanPay(order({ branchId: 2 }), 1, Money.of(1), takings('0'))).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('accepts up to what is still owed, net of refunds', () => {
    expect(() => checkCanPay(order(), 1, Money.of('70'), takings('100', '70'))).not.toThrow();
    expect(() => checkCanPay(order(), 1, Money.of('70.01'), takings('100', '70'))).toThrow(
      expect.objectContaining({ code: 'EXCEEDS_ORDER_TOTAL' }),
    );
  });

  it('refuses a cancelled order and a cash sale', () => {
    expect(() => checkCanPay(order({ status: 'CANCELLED' }), 1, Money.of(1), takings('0'))).toThrow(expect.objectContaining({ code: 'ORDER_CANCELLED' }));
    expect(() => checkCanPay(order({ saleType: 'cash_sale' }), 1, Money.of(1), takings('0'))).toThrow(expect.objectContaining({ code: 'CASH_ORDER_ALREADY_PAID' }));
  });
});

describe('checkCanRefund', () => {
  it('returns at most what is left of the payment', () => {
    expect(() => checkCanRefund(payment(), Money.of('30'), Money.of('10'))).not.toThrow();
    expect(() => checkCanRefund(payment(), Money.of('30'), Money.of('10.01'))).toThrow(expect.objectContaining({ code: 'EXCEEDS_PAYMENT_AMOUNT' }));
  });
});

describe('refundBankAccount', () => {
  it('sends a bank payment back to its own account unless another is named', () => {
    expect(refundBankAccount(payment({ paymentMethod: 'bank', bankAccountId: 3 }), null)).toBe(3);
    expect(refundBankAccount(payment({ paymentMethod: 'bank', bankAccountId: 3 }), 4)).toBe(4);
  });

  it('sends nothing else to a bank account', () => {
    expect(refundBankAccount(payment(), null)).toBeNull();
    expect(() => refundBankAccount(payment(), 3)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
