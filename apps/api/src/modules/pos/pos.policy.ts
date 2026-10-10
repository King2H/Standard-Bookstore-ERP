import { Money } from '@bms/shared';
import { BusinessError, ValidationError } from '../../lib/errors.js';
import type { PaymentLine, PosPaymentStatus, PosTransactionRecord, PricedLine, SaleLine } from './pos.types.js';

/**
 * Rules of counter sales (A5), pure: pricing and discounts, what a sale must
 * be paid with, and when it can still be voided.
 */

/**
 * Payments that differ from the total by up to a cent are taken as exact:
 * the till rounds each line, so its sum can be a cent off.
 */
const TOLERANCE = Money.of('0.01');

/** A line at its unit price, less its discount: a percentage, or an amount (at most the line's value). */
export function priceLine(line: SaleLine, unitPrice: Money): PricedLine {
  const base = unitPrice.times(line.quantity).round(2);
  const discountAmount =
    line.discountMode === 'Amount' && line.discountAmount !== undefined
      ? Money.min(Money.of(line.discountAmount), base).round(2)
      : base.percent(line.discountPct).round(2);
  return {
    bookId: line.bookId,
    quantity: line.quantity,
    unitPrice,
    discountPct: line.discountPct,
    discountAmount,
    lineTotal: base.minus(discountAmount),
  };
}

/** No line may be discounted more than the role's maximum, however the discount was entered. */
export function checkDiscounts(lines: PricedLine[], maxPct: number): void {
  for (const line of lines) {
    const base = line.unitPrice.times(line.quantity).round(2);
    if (line.discountAmount.greaterThan(base.percent(maxPct).round(2))) {
      const requested = base.isZero() ? 0 : Number(line.discountAmount.times(100).dividedBy(base.toFixed(2)).toFixed(2));
      throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', `Discount ${requested}% exceeds maximum allowed ${maxPct}%`, {
        maxDiscPct: maxPct,
        requested,
      });
    }
  }
}

export function totals(lines: PricedLine[]): { subtotal: Money; discountTotal: Money; taxTotal: Money; grandTotal: Money } {
  const subtotal = Money.sum(lines.map((l) => l.lineTotal));
  // Tax is not charged yet (ADR-0010: default 0%).
  return { subtotal, discountTotal: Money.sum(lines.map((l) => l.discountAmount)), taxTotal: Money.ZERO, grandTotal: subtotal };
}

export function paymentStatus(grandTotal: Money, paid: Money): PosPaymentStatus {
  if (!grandTotal.minus(paid).greaterThan(TOLERANCE)) return 'paid';
  return paid.greaterThan(TOLERANCE) ? 'partial' : 'credit';
}

/** What is still owed; nothing once the sale counts as paid. */
export function amountDue(grandTotal: Money, paid: Money): Money {
  return paymentStatus(grandTotal, paid) === 'paid' ? Money.ZERO : grandTotal.minus(paid);
}

/**
 * Store credit and loyalty points come from a customer's account, so they
 * need a customer on the sale.
 */
export function checkTender(payments: PaymentLine[], customerId: number | null): void {
  if (customerId !== null) return;
  if (payments.some((p) => p.method === 'store_credit')) {
    throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'Store credit payments require a customer on the sale.');
  }
  if (payments.some((p) => p.method === 'loyalty_points')) {
    throw new BusinessError('LOYALTY_REQUIRES_CUSTOMER', 'Loyalty point payments require a customer on the sale.');
  }
}

/**
 * A cash sale is paid in full; a credit sale (with a customer, due today or
 * later) may be paid in part or not at all, never more than its total.
 */
export function checkSalePayments(
  sale: { grandTotal: Money; paid: Money; allowCredit: boolean; customerId: number | null; dueDate: string | null },
  today: string,
): void {
  if (sale.allowCredit && sale.customerId === null) {
    throw new BusinessError('CREDIT_REQUIRES_CUSTOMER', 'Credit sales require a customer to be selected');
  }
  const due = sale.grandTotal.minus(sale.paid);
  if (!sale.allowCredit && due.abs().greaterThan(TOLERANCE)) {
    throw new BusinessError('PAYMENT_SUM_MISMATCH', `Payment sum ${sale.paid.toFixed()} does not match grand total ${sale.grandTotal.toFixed()}`, {
      amountPaid: sale.paid.toNumber(),
      grandTotal: sale.grandTotal.toNumber(),
    });
  }
  if (due.negate().greaterThan(TOLERANCE)) {
    throw new BusinessError('PAYMENT_EXCEEDS_TOTAL', `Payment ${sale.paid.toFixed()} exceeds grand total ${sale.grandTotal.toFixed()}`);
  }
  if (sale.dueDate !== null && sale.dueDate < today) {
    throw new ValidationError('The due date must be today or later', { field: 'dueDate' });
  }
}

/** A later payment on a credit or part-paid sale, for no more than is due. */
export function checkCanCollect(t: PosTransactionRecord, incoming: Money): void {
  if (t.status === 'voided') throw new BusinessError('TRANSACTION_VOIDED', 'Cannot record payment on a voided transaction');
  if (t.paymentStatus === 'paid') throw new BusinessError('ALREADY_PAID', 'Transaction is already fully paid');
  if (incoming.greaterThan(t.amountDue)) {
    throw new BusinessError('PAYMENT_EXCEEDS_DUE', `Payment ${incoming.toFixed()} exceeds outstanding balance ${t.amountDue.toFixed()}`, {
      amountDue: t.amountDue.toNumber(),
      incoming: incoming.toNumber(),
    });
  }
}

/**
 * A void is the same-day correction (owner decision 1a): on the day of the
 * sale, while nothing on it was returned. Later, the Returns flow applies.
 */
export function isVoidable(t: Pick<PosTransactionRecord, 'status' | 'soldOn' | 'today' | 'hasReturns'>): boolean {
  return t.status === 'completed' && t.soldOn === t.today && !t.hasReturns;
}

export function checkCanVoid(t: Pick<PosTransactionRecord, 'status' | 'soldOn' | 'today' | 'hasReturns'>): void {
  if (t.status === 'voided') throw new BusinessError('ALREADY_VOIDED', 'Transaction is already voided');
  if (t.soldOn !== t.today) {
    throw new BusinessError('VOID_WINDOW_CLOSED', 'A sale can be voided only on the day it was made; use a return instead');
  }
  if (t.hasReturns) {
    throw new BusinessError('TRANSACTION_HAS_RETURNS', 'Books from this sale were returned; use a return for the rest');
  }
}
