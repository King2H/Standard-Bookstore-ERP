import { Money } from '@bms/shared';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import type { OrderForPayment, OrderPaymentStatus, OrderTakings, PaymentRecord, PaymentStatus } from './payments.types.js';

/**
 * Rules of order payments and refunds (A5), pure: what may be paid or
 * refunded, and the statuses and balances that follow.
 */

const isCancelled = (status: string) => status.toUpperCase() === 'CANCELLED';

/** Paid less refunded. */
export function netPaid(t: OrderTakings): Money {
  return t.paid.minus(t.refunded);
}

/** What the customer still owes on the order, never below zero. */
export function outstanding(total: Money, t: OrderTakings): Money {
  return Money.max(0, total.minus(netPaid(t)));
}

/**
 * The order's payment status from its takings. A refunded credit sale is
 * owed again (owner decision 2a), so it is unpaid or partial; only a cash
 * sale whose payments were all refunded is "refunded".
 */
export function orderPaymentStatus(order: Pick<OrderForPayment, 'saleType'>, total: Money, t: OrderTakings): OrderPaymentStatus {
  const net = netPaid(t);
  if (order.saleType !== 'credit_sale' && t.paid.greaterThan(0) && !t.refunded.lessThan(t.paid)) return 'refunded';
  if (!net.greaterThan(0)) return 'unpaid';
  if (!net.lessThan(total)) return 'paid';
  return 'partial';
}

function orderTotal(order: OrderForPayment): Money {
  if (order.total === null) {
    throw new BusinessError('ORDER_INVALID', 'Order has no total. Ensure the order was created with valid book prices.');
  }
  return order.total;
}

/**
 * A payment is taken in the order's own branch (the session branch), on a
 * credit order that is not cancelled, for no more than is still owed.
 * Returns the order's total.
 */
export function checkCanPay(order: OrderForPayment, branchId: number, amount: Money, t: OrderTakings): Money {
  // Like recordInBranch() for a write: another branch's order does not exist here.
  if (order.branchId !== branchId) throw new NotFoundError('Order');
  if (isCancelled(order.status)) throw new BusinessError('ORDER_CANCELLED', 'Cannot record payment on a cancelled order');
  if (order.saleType === 'cash_sale') {
    throw new BusinessError(
      'CASH_ORDER_ALREADY_PAID',
      'Cash orders are paid automatically at confirmation. Payment collection is only available for credit orders.',
    );
  }
  const total = orderTotal(order);
  if (!amount.greaterThan(0)) throw new ValidationError('Payment amount must be positive');
  const owed = outstanding(total, t);
  if (amount.greaterThan(owed)) {
    throw new BusinessError(
      'EXCEEDS_ORDER_TOTAL',
      `Payment of ETB ${amount.toFixed()} would exceed order total ETB ${total.toFixed()}. Already paid: ETB ${netPaid(t).toFixed()}`,
      {
        orderTotal: total.toNumber(),
        alreadyPaid: netPaid(t).toNumber(),
        requested: amount.toNumber(),
        outstanding: owed.toNumber(),
      },
    );
  }
  return total;
}

/** A refund returns at most what is left of the payment. */
export function checkCanRefund(payment: PaymentRecord, alreadyRefunded: Money, amount: Money): void {
  if (payment.status === 'failed') throw new BusinessError('PAYMENT_FAILED', 'Cannot refund a failed payment');
  if (!amount.greaterThan(0)) throw new ValidationError('Refund amount must be positive');
  if (alreadyRefunded.plus(amount).greaterThan(payment.amount)) {
    throw new BusinessError(
      'EXCEEDS_PAYMENT_AMOUNT',
      `Refund of ETB ${amount.toFixed()} would exceed payment amount ETB ${payment.amount.toFixed()}. Already refunded: ETB ${alreadyRefunded.toFixed()}`,
      { paymentAmount: payment.amount.toNumber(), alreadyRefunded: alreadyRefunded.toNumber(), requested: amount.toNumber() },
    );
  }
}

export function paymentStatusAfterRefund(payment: PaymentRecord, refundedTotal: Money): PaymentStatus {
  return refundedTotal.lessThan(payment.amount) ? 'partially_refunded' : 'refunded';
}

/**
 * The money goes back the way it came (owner decision 2a): a bank payment to
 * a bank account (the payment's own unless another is named); nothing else
 * goes to a bank account.
 */
export function refundBankAccount(payment: PaymentRecord, requested: number | null): number | null {
  if (payment.paymentMethod !== 'bank') {
    if (requested !== null) {
      throw new ValidationError(`A ${payment.paymentMethod} payment is refunded the same way, not to a bank account`);
    }
    return null;
  }
  const account = requested ?? payment.bankAccountId;
  if (account === null) throw new ValidationError('bankAccountId is required to refund a bank payment');
  return account;
}
