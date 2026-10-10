import { Money } from '@bms/shared';
import { BusinessError, NotFoundError } from '../../lib/errors.js';
import type { RefundMethod, RefundPart, SaleForReturn, SaleLine, Tender } from './returns.types.js';

/**
 * Rules of returns (A5), pure: which sale and how much of it can come back,
 * what it is worth, and how its value goes back.
 */

/** A sale is returned in its own branch, the session's (owner decision 4a), while it stands. */
export function checkSale(sale: SaleForReturn, branchId: number): void {
  // Like recordInBranch() for a write: another branch's sale does not exist here.
  if (sale.branchId !== branchId) throw new NotFoundError('Transaction');
  if (sale.status === 'voided') throw new BusinessError('TRANSACTION_VOIDED', 'Cannot return a voided transaction');
}

/**
 * What `quantity` units of a line are worth: their share of what the line
 * cost after its discount, however that discount was given. The last units
 * of a line take what is left of it, so the line never refunds more than it cost.
 */
export function lineValue(line: SaleLine, quantity: number): Money {
  const remaining = line.quantity - line.returnedQuantity;
  if (quantity > remaining) {
    throw new BusinessError('OVER_RETURN', `Cannot return ${quantity} units. Max returnable: ${remaining}`, {
      soldQty: line.quantity,
      alreadyReturned: line.returnedQuantity,
      requested: quantity,
      maxReturnable: remaining,
    });
  }
  if (quantity === remaining) return line.lineTotal.minus(line.returnedValue);
  return line.lineTotal.times(quantity).dividedBy(line.quantity).round(2);
}

/** Above the limit, a Manager or Admin processes the return (owner decision 3a). */
export function checkApproval(total: Money, maxWithoutAuth: Money, role: string): boolean {
  const privileged = role === 'Manager' || role === 'Admin';
  if (total.greaterThan(maxWithoutAuth) && !privileged) {
    throw new BusinessError(
      'APPROVAL_REQUIRED',
      `Refund of ETB ${total.toFixed()} exceeds the limit of ETB ${maxWithoutAuth.toFixed()}. A Manager or Admin must process this return.`,
      { totalRefundAmount: total.toNumber(), maxWithoutAuth: maxWithoutAuth.toNumber() },
    );
  }
  return privileged;
}

/**
 * How `amount` goes back (owner decision 2a): the way the sale was paid,
 * newest payment method first, each up to what it has not given back yet.
 * After the return window a branch may allow store credit only. Store
 * credit and points need a customer's account; without one they go back
 * as cash.
 */
export function allocateRefund(
  amount: Money,
  tenders: Tender[],
  opts: { storeCreditOnly: boolean; hasCustomer: boolean; paidLeft: Money },
): RefundPart[] {
  if (!amount.greaterThan(0)) return [];
  if (amount.greaterThan(opts.paidLeft)) {
    throw new BusinessError('REFUND_EXCEEDS_PAID', `Refund ETB ${amount.toFixed()} exceeds what is left of the amount paid, ETB ${opts.paidLeft.toFixed()}`, {
      totalRefundAmount: amount.toNumber(),
      amountPaid: opts.paidLeft.toNumber(),
    });
  }
  if (opts.storeCreditOnly) {
    if (!opts.hasCustomer) {
      throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'After the return window only store credit is refunded, and the sale has no customer.');
    }
    return [{ method: 'store_credit', amount }];
  }
  const parts = new Map<RefundMethod, Money>();
  let left = amount;
  for (const t of [...tenders].sort((a, b) => b.lastPaidAt.getTime() - a.lastPaidAt.getTime())) {
    if (!left.greaterThan(0)) break;
    const take = Money.min(left, t.available);
    if (!take.greaterThan(0)) continue;
    const method: RefundMethod = !opts.hasCustomer && (t.method === 'store_credit' || t.method === 'loyalty_points') ? 'cash' : t.method;
    parts.set(method, (parts.get(method) ?? Money.ZERO).plus(take));
    left = left.minus(take);
  }
  // Payments without a method on record (none expected) come back as cash.
  if (left.greaterThan(0)) parts.set('cash', (parts.get('cash') ?? Money.ZERO).plus(left));
  return [...parts].map(([method, value]) => ({ method, amount: value }));
}

/** The one method a return went back by, or mixed. */
export function refundMethodOf(parts: RefundPart[]): RefundMethod | 'mixed' {
  const methods = new Set(parts.map((p) => p.method));
  if (methods.size === 0) return 'cash'; // nothing to give back: free books
  return methods.size === 1 ? [...methods][0] : 'mixed';
}

/** The sale's payment status once a credit note took `credited` off what it owes. */
export function saleAfterCredit(sale: Pick<SaleForReturn, 'amountPaid' | 'amountDue'>, credited: Money): { due: Money; status: 'paid' | 'partial' | 'credit' } {
  const due = Money.max(0, sale.amountDue.minus(credited));
  if (!due.greaterThan(0)) return { due, status: 'paid' };
  return { due, status: sale.amountPaid.greaterThan(0) ? 'partial' : 'credit' };
}

/** After the return window a branch may refund store credit only. */
export function storeCreditOnly(daysSinceSale: number, windowDays: number, afterWindow: 'any' | 'store_credit_only'): boolean {
  return daysSinceSale > windowDays && afterWindow === 'store_credit_only';
}

/**
 * Points the sale earned go back in proportion to what was returned of it,
 * all returns on the sale together, less what earlier returns took back.
 */
export function pointsToTakeBack(p: { earned: number; reversed: number; returnedValue: Money; grandTotal: Money }): number {
  if (p.earned <= 0 || !p.grandTotal.greaterThan(0)) return 0;
  const returned = Money.min(p.returnedValue, p.grandTotal);
  const due = Math.floor(Money.of(p.earned).times(returned.toFixed(4)).dividedBy(p.grandTotal.toFixed(4)).toNumber(4));
  return Math.max(0, due - p.reversed);
}
