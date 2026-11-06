import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { getLoyaltyAccrualRate, getLoyaltyMinTransactionAmount } from '../config/config.service.js';
import * as customers from '../customer/customer.repository.js';
import { pointsToTakeBack } from '../returns/returns.policy.js';
import { orderPointsToEarn } from './orders.policy.js';
import * as orders from './orders.repository.js';

/**
 * Loyalty points on a customer order (#249, #225 M6; was: orders earned none).
 * Earned in the same transaction as what completes the order or pays it in
 * full, whichever comes last, at the counter's rate on what the customer kept;
 * taken back in proportion when delivered books come back later, as for a
 * counter sale. A customer with no loyalty account earns nothing, as at the
 * counter.
 */
export async function earnIfDone(q: Queryable, orderId: string): Promise<void> {
  const o = await orders.pointsBasis(q, orderId);
  if (!o || o.customerId === null) return;
  const [rate, minAmount] = await Promise.all([getLoyaltyAccrualRate(), getLoyaltyMinTransactionAmount()]);
  const points = orderPointsToEarn({
    status: o.status, paymentStatus: o.paymentStatus, earned: o.earned,
    total: Money.of(o.total), returned: Money.of(o.returnedBefore), rate, minAmount,
  });
  if (points <= 0) return;
  if ((await customers.lockPoints(q, o.customerId)) === undefined) return;
  await customers.addPoints(q, o.customerId, points, { reason: 'ACCRUAL', transactionRef: o.orderNumber });
}

/** Takes back the points delivered books returned after the order earned them, as far as the balance allows. */
export async function takeBackOnReturn(q: Queryable, orderId: string): Promise<void> {
  const o = await orders.pointsBasis(q, orderId);
  if (!o || o.customerId === null || o.earned <= 0) return;
  const due = pointsToTakeBack({
    earned: o.earned, reversed: o.reversed,
    returnedValue: Money.of(o.returnedAfter),
    grandTotal: Money.of(o.total).minus(o.returnedBefore),
  });
  if (due <= 0) return;
  const balance = (await customers.lockPoints(q, o.customerId)) ?? 0;
  const takeBack = Math.min(due, Math.max(0, balance));
  if (takeBack > 0) await customers.addPoints(q, o.customerId, -takeBack, { reason: 'RETURN_REVERSAL', transactionRef: o.orderNumber });
}
