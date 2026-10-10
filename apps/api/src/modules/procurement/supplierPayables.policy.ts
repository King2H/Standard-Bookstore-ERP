import { Money } from '@bms/shared';
import { BusinessError } from '../../lib/errors.js';
import type { PurchaseOrderStatus } from './procurement.types.js';

/**
 * Rules of supplier payables (A5), pure: when an order can be paid or
 * credited, how much, and how the supplier ledger adds up.
 */

/** An order is owed for once it was approved; never while a draft, waiting for approval, or cancelled. */
const NOT_A_COMMITMENT: PurchaseOrderStatus[] = ['draft', 'pending_approval', 'cancelled'];

export function checkPayable(status: PurchaseOrderStatus): void {
  if (NOT_A_COMMITMENT.includes(status)) {
    throw new BusinessError('PO_NOT_PAYABLE', `Cannot record a payment against a Purchase Order in status '${status}'`);
  }
}

export function checkCreditable(status: PurchaseOrderStatus): void {
  if (NOT_A_COMMITMENT.includes(status)) {
    throw new BusinessError('PO_NOT_CREDITABLE', `Cannot record a credit note against a Purchase Order in status '${status}'`);
  }
}

/**
 * Payments and credit notes together stay within what was ordered (owner
 * decision 4a): paying before delivery is an advance, paying more than the
 * order is a mistake.
 */
export function checkWithinOrderTotal(orderTotal: Money, settled: Money, amount: Money): void {
  if (settled.plus(amount).greaterThan(orderTotal)) {
    throw new BusinessError(
      'EXCEEDS_ORDER_TOTAL',
      `Payments and credit notes would come to ETB ${settled.plus(amount).toFixed()}, more than the order's ETB ${orderTotal.toFixed()}`,
      { orderTotal: orderTotal.toNumber(), settled: settled.toNumber(), requested: amount.toNumber() },
    );
  }
}

/** A payment is reversed once (owner decision 1a). */
export function checkCanReverse(payment: { reversedAt: Date | null }): void {
  if (payment.reversedAt !== null) throw new BusinessError('ALREADY_REVERSED', 'This payment was already reversed');
}

export interface LedgerEvent {
  /** YYYY-MM-DD in the database's calendar. */
  day: string;
  type: 'PO' | 'GOODS_RECEIPT' | 'PAYMENT' | 'PAYMENT_REVERSAL' | 'CREDIT_NOTE';
  reference: string;
  description: string;
  /** + adds to what is owed; − settles it. */
  amount: Money;
}

/**
 * The running balance over every event, oldest first; the entries shown are
 * those within the dates, each carrying the balance after it.
 */
export function buildLedger(
  events: LedgerEvent[],
  range: { dateFrom?: string; dateTo?: string },
): { entries: Array<LedgerEvent & { balance: Money }>; currentBalance: Money } {
  let balance = Money.ZERO;
  const entries: Array<LedgerEvent & { balance: Money }> = [];
  for (const e of events) {
    balance = balance.plus(e.amount);
    if (range.dateFrom && e.day < range.dateFrom) continue;
    if (range.dateTo && e.day > range.dateTo) continue;
    entries.push({ ...e, balance });
  }
  return { entries, currentBalance: balance };
}
