import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { accountForPayment, bankAccountsEnabled, movementNote, recordMovement } from '../bankAccount/bankAccount.service.js';
import * as customers from '../customer/customer.repository.js';
import { checkNotWrittenOff, reopenOnRefund, updateReceivableOnPayment } from '../receivables/receivables.service.js';
import * as policy from './payments.policy.js';
import * as payments from './payments.repository.js';
import type {
  Actor,
  NewPayment,
  NewRefund,
  OrderBalanceRecord,
  OrderForPayment,
  Paging,
  PaymentFilter,
  PaymentRecord,
  RefundRecord,
  UnpaidFilter,
  UnpaidRecord,
} from './payments.types.js';

/**
 * Use cases of order payments (A4): taking a payment on a credit order,
 * refunding one, and the lists the Payments page reads. One function each,
 * owning its transaction. Installment plans were retired (owner decision,
 * 2026-10-10); their endpoints answer 410.
 */

function audit(q: Queryable, actor: Actor, entityType: string, id: string, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action: 'CREATE',
    entityType,
    entityId: id,
    meta,
  });
}

function window(paging: Paging) {
  return { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize };
}

function foundOrder(order: OrderForPayment | undefined): OrderForPayment {
  if (order === undefined) throw new NotFoundError('Order');
  return order;
}

/**
 * Brings the order's payment status, and its receivable on a credit sale, in
 * line with what was paid and refunded.
 */
async function settleOrder(q: Queryable, order: OrderForPayment, total: Money, change: 'payment' | 'refund') {
  const takings = await payments.takings(q, order.id);
  const status = policy.orderPaymentStatus(order, total, takings);
  await payments.setOrderPaymentStatus(q, order.id, status);
  if (order.saleType === 'credit_sale') {
    const owed = policy.outstanding(total, takings);
    const receivable = { sourceType: 'order_credit_sale' as const, sourceEntityId: Number(order.id), newOutstandingAmount: owed };
    if (change === 'payment') await updateReceivableOnPayment(q, { ...receivable, isFullySettled: status === 'paid' });
    else await reopenOnRefund(q, receivable);
  }
  return status;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<PaymentRecord> {
  const payment = await payments.findPayment(kysely, id);
  if (!payment) throw new NotFoundError('Payment');
  return { ...payment, refunds: await payments.refundsOf(kysely, id) };
}

export function list(filter: PaymentFilter, paging: Paging): Promise<{ items: PaymentRecord[]; total: number }> {
  return payments.listHistory(kysely, filter, window(paging));
}

export function listUnpaid(filter: UnpaidFilter, paging: Paging): Promise<{ items: UnpaidRecord[]; total: number }> {
  return payments.listUnpaid(kysely, filter, window(paging));
}

export async function listByOrder(orderId: string): Promise<PaymentRecord[]> {
  return payments.paymentsOfOrder(kysely, orderId);
}

export async function getOrderBalance(orderId: string): Promise<OrderBalanceRecord> {
  const order = foundOrder(await payments.findOrder(kysely, orderId));
  if (order.total === null) {
    throw new BusinessError('ORDER_INVALID', 'Order has no total amount. The order may have been created with books that have no price set.');
  }
  const takings = await payments.takings(kysely, orderId);
  return {
    orderTotal: order.total,
    totalPaid: takings.paid,
    totalRefunded: takings.refunded,
    outstanding: policy.outstanding(order.total, takings),
    paymentStatus: order.paymentStatus,
  };
}

// ── Taking a payment ──────────────────────────────────────────────────────────

/**
 * A payment on a credit order of the session branch. The order is locked,
 * so two payments at once cannot together pay more than is owed; store
 * credit and loyalty points are spent under lock too.
 */
export async function createPayment(actor: Actor, p: NewPayment): Promise<PaymentRecord> {
  const paymentId = await withTransaction({}, async (tx) => {
    // The money comes in at the session branch, which must be the order's (checkCanPay).
    // With bank accounts on, a bank payment names an active account of it (#21).
    const bankAccountId = p.paymentMethod === 'bank' ? await accountForPayment(tx, p.bankAccountId, actor.branchId) : null;
    const order = foundOrder(await payments.findOrder(tx, p.orderId, { forUpdate: true }));
    const total = policy.checkCanPay(order, actor.branchId, p.amount, await payments.takings(tx, order.id));
    await checkNotWrittenOff(tx, 'order_credit_sale', order.id);

    const reference = await nextDailyNumber(tx, 'PAY');
    if (p.paymentMethod === 'store_credit') await checkStoreCredit(tx, order, p.amount);
    if (p.paymentMethod === 'loyalty_points') await spendPoints(tx, order, p.amount, reference);

    const id = await payments.insertPayment(tx, { ...p, bankAccountId, reference, processedBy: actor.staffId });
    if (p.paymentMethod === 'store_credit') {
      await customers.moveStoreCredit(tx, order.customerId as number, p.amount, { direction: 'debit', refType: 'order_payment', refId: id });
    }
    if (bankAccountId !== null) {
      await recordMovement(tx, { bankAccountId, direction: 'in', amount: p.amount, sourceType: 'order_payment', sourceId: id,
        notes: movementNote(`Payment ${reference}`, { payerBank: p.payerBank, reference: p.transactionReference }) });
    }

    const status = await settleOrder(tx, order, total, 'payment');
    await audit(tx, actor, 'payment', id, {
      paymentReference: reference,
      orderId: Number(order.id),
      amount: p.amount.toNumber(),
      paymentMethod: p.paymentMethod,
      newPaymentStatus: status,
    });
    const event = { paymentId: id, amount: p.amount.toNumber(), orderNumber: order.orderNumber, orderId: order.id, branchId: actor.branchId };
    await insertOutboxEvent(tx, 'payment.recorded', { ...event, method: p.paymentMethod });
    if (p.paymentMethod === 'bank') await insertOutboxEvent(tx, 'payment.bank_transfer', event);
    return id;
  });
  return getById(paymentId);
}

/** Checks the balance under lock; the debit is written once the payment has its id. */
async function checkStoreCredit(q: Queryable, order: OrderForPayment, amount: Money): Promise<void> {
  if (order.customerId === null) {
    throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'Store credit payments require the order to be linked to a customer.');
  }
  const available = await customers.lockStoreCredit(q, order.customerId);
  if (available === undefined) throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Customer has no store credit account.');
  if (available.lessThan(amount)) {
    throw new BusinessError(
      'INSUFFICIENT_STORE_CREDIT',
      `Insufficient store credit. Available: ETB ${available.toFixed()}, requested: ETB ${amount.toFixed()}`,
      { available: available.toNumber(), requested: amount.toNumber() },
    );
  }
}

/** One loyalty point pays one ETB. */
async function spendPoints(q: Queryable, order: OrderForPayment, amount: Money, reference: string): Promise<void> {
  if (order.customerId === null) {
    throw new BusinessError('LOYALTY_REQUIRES_CUSTOMER', 'Loyalty point payments require the order to be linked to a customer.');
  }
  const available = await customers.lockPoints(q, order.customerId);
  if (available === undefined) throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Customer has no loyalty account.');
  if (Money.of(available).lessThan(amount)) {
    throw new BusinessError(
      'INSUFFICIENT_LOYALTY_POINTS',
      `Insufficient loyalty points. Available: ${available} pts, requested: ${amount.toFixed()} pts`,
      { available, requested: amount.toNumber() },
    );
  }
  await customers.addPoints(q, order.customerId, -amount.toNumber(), { reason: 'REDEMPTION', transactionRef: reference });
}

// ── Refunding a payment ───────────────────────────────────────────────────────

/**
 * Gives back (part of) a payment, the way it was paid (owner decision 2a):
 * store credit and loyalty points go back to the customer's account, a bank
 * payment to an active bank account of the branch. On a credit sale the
 * refunded amount is owed again. The payment is locked, so two refunds at
 * once cannot return more than was paid.
 */
/**
 * Gives back everything a cancelled order took, in the cancel's transaction
 * (#167, decision 1a): each payment the way it was paid, newest first, or all
 * of it as store credit for the order's customer. Returns what went back.
 */
export async function returnOrderPayments(
  q: Queryable,
  actor: Actor,
  orderId: string,
  opts: { to: 'original' | 'store_credit'; reason: string },
): Promise<Money> {
  const parts = await refundOrderPayments(q, actor, orderId, { ...opts, amount: null, returnId: null });
  return Money.sum(parts.map((p) => p.amount));
}

/**
 * Gives back `amount` of what a returned order was paid, in the return's
 * transaction (#166): from its payments newest first, each the way it was
 * paid, or as store credit after the return window. Each refund names the
 * return, so it counts once in Payments and the reports. The order is locked
 * by the return. Returns how much went back by each method.
 */
export function refundReturnedOrder(
  q: Queryable,
  actor: Actor,
  orderId: string,
  opts: { amount: Money; returnId: string; returnNumber: string; to: 'original' | 'store_credit' },
): Promise<Array<{ method: string; amount: Money }>> {
  return refundOrderPayments(q, actor, orderId, { to: opts.to, reason: `Return ${opts.returnNumber}`, amount: opts.amount, returnId: opts.returnId });
}

/** What a returned order's payments can still give back: paid less refunded. */
export async function refundableOnOrder(q: Queryable, orderId: string): Promise<Money> {
  return policy.netPaid(await payments.takings(q, orderId));
}

/** The order's payment status once a return took part of it back (#166). */
export async function settleReturnedOrder(q: Queryable, orderId: string): Promise<void> {
  const order = foundOrder(await payments.findOrder(q, orderId));
  if (order.total === null) return;
  await payments.setOrderPaymentStatus(q, order.id, policy.orderPaymentStatus(order, order.total, await payments.takings(q, order.id)));
}

/**
 * The refund loop of a cancel and a return: newest payment first, each up to
 * what it has not given back, until `amount` (everything, when null) went back.
 */
async function refundOrderPayments(
  q: Queryable,
  actor: Actor,
  orderId: string,
  opts: { to: 'original' | 'store_credit'; reason: string; amount: Money | null; returnId: string | null },
): Promise<Array<{ method: string; amount: Money }>> {
  const order = foundOrder(await payments.findOrder(q, orderId, { forUpdate: true }));
  const taken = (await payments.paymentsOfOrder(q, orderId)).filter((p) => p.status === 'success' || p.status === 'partially_refunded');
  const parts: Array<{ method: string; amount: Money }> = [];
  let left = opts.amount;
  for (const payment of taken.reverse()) {
    if (left !== null && !left.greaterThan(0)) break;
    const earlier = Money.sum((await payments.refundsOf(q, payment.id)).map((x) => x.refundAmount));
    const open = payment.amount.minus(earlier);
    const amount = left === null ? open : Money.min(left, open);
    if (!amount.greaterThan(0)) continue;
    const toCredit = opts.to === 'store_credit';
    const method = toCredit ? 'store_credit' : payment.paymentMethod;
    const refundTo = toCredit ? null : policy.refundBankAccount(payment, null, bankAccountsEnabled());
    const bankAccountId = refundTo === null ? null : await accountForPayment(q, refundTo, order.branchId);
    const refund = await payments.insertRefund(q, {
      payment, amount, reason: opts.reason, bankAccountId, processedBy: actor.staffId, returnId: opts.returnId, ...(toCredit && { method }),
    });
    if (bankAccountId !== null) {
      await recordMovement(q, { bankAccountId, direction: 'out', amount, sourceType: 'order_refund', sourceId: refund.id, notes: `Refund of ${payment.paymentReference}` });
    }
    if (order.customerId !== null && (toCredit || payment.paymentMethod === 'store_credit')) {
      await customers.moveStoreCredit(q, order.customerId, amount, { direction: 'credit', refType: 'order_refund', refId: refund.id });
    } else if (order.customerId !== null && payment.paymentMethod === 'loyalty_points') {
      await customers.addPoints(q, order.customerId, amount.toNumber(), { reason: 'REFUND', transactionRef: payment.paymentReference });
    }
    const paymentStatus = policy.paymentStatusAfterRefund(payment, earlier.plus(amount));
    await payments.setPaymentStatus(q, payment.id, paymentStatus);
    await audit(q, actor, 'payment_refund', refund.id, {
      paymentId: payment.id, orderId: Number(order.id), refundAmount: amount.toNumber(), method, reason: opts.reason,
      ...(opts.returnId === null ? { orderCancelled: true } : { returnId: Number(opts.returnId) }),
    });
    await insertOutboxEvent(q, 'payment.refunded', {
      paymentId: payment.id, refundId: refund.id, amount: amount.toNumber(), orderNumber: order.orderNumber, orderId: order.id, branchId: actor.branchId,
    });
    const part = parts.find((p) => p.method === method);
    if (part) part.amount = part.amount.plus(amount);
    else parts.push({ method, amount });
    if (left !== null) left = left.minus(amount);
  }
  if (parts.length > 0 && order.total !== null) await settleOrder(q, order, order.total, 'refund');
  return parts;
}

export async function refund(actor: Actor, paymentId: string, r: NewRefund): Promise<RefundRecord> {
  return withTransaction({}, async (tx) => {
    const payment = await payments.findPayment(tx, paymentId, { forUpdate: true });
    if (!payment) throw new NotFoundError('Payment');
    const order = foundOrder(await payments.findOrder(tx, payment.orderId, { forUpdate: true }));
    const earlier = Money.sum((await payments.refundsOf(tx, payment.id)).map((x) => x.refundAmount));
    policy.checkCanRefund(payment, earlier, r.refundAmount);
    // A written-off debt is closed: refunding would make it owed again.
    await checkNotWrittenOff(tx, 'order_credit_sale', order.id);
    const refundTo = policy.refundBankAccount(payment, r.bankAccountId, bankAccountsEnabled());
    const bankAccountId = refundTo === null ? null : await accountForPayment(tx, refundTo, order.branchId);

    const refund = await payments.insertRefund(tx, {
      payment,
      amount: r.refundAmount,
      reason: r.reason,
      bankAccountId,
      processedBy: actor.staffId,
    });
    if (bankAccountId !== null) {
      await recordMovement(tx, { bankAccountId, direction: 'out', amount: r.refundAmount, sourceType: 'order_refund', sourceId: refund.id, notes: `Refund of ${payment.paymentReference}` });
    }
    if (order.customerId !== null && payment.paymentMethod === 'store_credit') {
      await customers.moveStoreCredit(tx, order.customerId, r.refundAmount, { direction: 'credit', refType: 'order_refund', refId: refund.id });
    }
    if (order.customerId !== null && payment.paymentMethod === 'loyalty_points') {
      await customers.addPoints(tx, order.customerId, r.refundAmount.toNumber(), { reason: 'REFUND', transactionRef: payment.paymentReference });
    }

    const paymentStatus = policy.paymentStatusAfterRefund(payment, earlier.plus(r.refundAmount));
    await payments.setPaymentStatus(tx, payment.id, paymentStatus);
    const orderPaymentStatus = order.total === null ? undefined : await settleOrder(tx, order, order.total, 'refund');

    await audit(tx, actor, 'payment_refund', refund.id, {
      paymentId: payment.id,
      orderId: Number(order.id),
      refundAmount: r.refundAmount.toNumber(),
      method: payment.paymentMethod,
      reason: r.reason,
      newPaymentStatus: paymentStatus,
      newOrderPaymentStatus: orderPaymentStatus,
    });
    await insertOutboxEvent(tx, 'payment.refunded', {
      paymentId: payment.id,
      refundId: refund.id,
      amount: r.refundAmount.toNumber(),
      orderNumber: order.orderNumber,
      orderId: order.id,
      branchId: actor.branchId,
    });
    return refund;
  });
}
