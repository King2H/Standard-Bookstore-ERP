import { Money } from '@bms/shared';
import { BusinessError } from '../../lib/errors.js';
import { checkSalePayments } from '../pos/pos.policy.js';
import { isVoidable } from './exchanges.mapper.js';
import type { ExchangeRecord, RefundMethod, SettlementType } from './exchanges.types.js';

/**
 * Rules of exchanges (A5), pure: what the books are worth, who owes the
 * difference and how it is settled, and when an exchange can be undone.
 */

const TOLERANCE = Money.of('0.01');

/** Outgoing less incoming: above zero the customer owes, below zero the store does. */
export function settlementType(net: Money): SettlementType {
  if (net.greaterThan(TOLERANCE)) return 'Customer_Pays';
  if (net.lessThan(TOLERANCE.negate())) return 'Store_Refunds';
  return 'Even';
}

/**
 * A book brought in is worth at most what the store sells it for (owner
 * decision 4a). A book with no price yet (one just registered from the
 * exchange screen) has nothing to be held to, so only a Manager or Admin
 * values it.
 */
export function checkTradeInValue(bookId: number, unitValue: Money, sellingPrice: Money | null, role: string): void {
  if (sellingPrice === null) {
    if (role !== 'Manager' && role !== 'Admin') {
      throw new BusinessError('APPROVAL_REQUIRED', `Book ${bookId} has no price yet; a Manager or Admin values it`, { bookId });
    }
    return;
  }
  if (unitValue.greaterThan(sellingPrice)) {
    throw new BusinessError(
      'TRADE_IN_ABOVE_PRICE',
      `Book ${bookId} is valued at ETB ${unitValue.toFixed()}, more than its selling price of ETB ${sellingPrice.toFixed()}`,
      { bookId, unitValue: unitValue.toNumber(), sellingPrice: sellingPrice.toNumber() },
    );
  }
}

/** Above the approval limit, a Manager or Admin completes the exchange (owner decision 4a). */
export function checkApproval(tradeInValue: Money, maxWithoutAuth: Money, role: string): void {
  if (tradeInValue.greaterThan(maxWithoutAuth) && role !== 'Manager' && role !== 'Admin') {
    throw new BusinessError(
      'APPROVAL_REQUIRED',
      `Books brought in are worth ETB ${tradeInValue.toFixed()}, above the limit of ETB ${maxWithoutAuth.toFixed()}. A Manager or Admin must complete this exchange.`,
      { tradeInValue: tradeInValue.toNumber(), maxWithoutAuth: maxWithoutAuth.toNumber() },
    );
  }
}

/**
 * How the difference is settled. The customer pays what they owe at the
 * counter, and leaves the rest on credit only when asked to, with a customer
 * (owner decision 2a); store credit back needs a customer (3a).
 */
export function checkSettlement(
  s: { net: Money; paid: Money; allowCredit: boolean; customerId: number | null; dueDate: string | null; refundMethod: RefundMethod },
  today: string,
): void {
  const type = settlementType(s.net);
  if (type === 'Customer_Pays') {
    checkSalePayments({ grandTotal: s.net, paid: s.paid, allowCredit: s.allowCredit, customerId: s.customerId, dueDate: s.dueDate }, today);
    return;
  }
  if (s.paid.greaterThan(0)) {
    throw new BusinessError('PAYMENT_EXCEEDS_TOTAL', `Nothing is owed on this exchange; payments of ${s.paid.toFixed()} were given`);
  }
  if (type === 'Store_Refunds' && s.refundMethod === 'store_credit' && s.customerId === null) {
    throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'A refund as store credit needs a customer; choose one or refund cash.');
  }
}

/** A Quick Exchange is voided on the day it was made (owner decision 5a); later, a new exchange or a return. */
export function checkCanVoid(e: Pick<ExchangeRecord, 'status' | 'lifecycleStatus' | 'madeOn' | 'today' | 'voidedAt'>): void {
  if (e.voidedAt !== null) throw new BusinessError('ALREADY_VOIDED', 'Exchange is already voided');
  if (e.lifecycleStatus !== null || e.status !== 'Completed') {
    throw new BusinessError('EXCHANGE_NOT_CANCELLABLE', 'Only a completed exchange can be voided');
  }
  if (!isVoidable(e)) {
    throw new BusinessError('VOID_WINDOW_CLOSED', 'An exchange can be voided only on the day it was made; use a new exchange or a return instead');
  }
}

/** Store credit given back can be taken back only while the customer still has it. */
export function checkStoreCreditUnspent(balance: Money, given: Money): void {
  if (balance.lessThan(given)) {
    throw new BusinessError('STORE_CREDIT_SPENT', `The customer has ETB ${balance.toFixed()} of the ETB ${given.toFixed()} store credit this exchange gave`, {
      balance: balance.toNumber(),
      given: given.toNumber(),
    });
  }
}
