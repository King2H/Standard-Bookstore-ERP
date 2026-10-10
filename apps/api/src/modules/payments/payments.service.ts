import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
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

/** An active bank account of the branch the money moves in. */
async function checkBankAccount(q: Queryable, bankAccountId: number, branchId: number): Promise<void> {
  const account = await payments.findBankAccount(q, bankAccountId);
  if (!account) throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account not found');
  if (!account.isActive) throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account is inactive');
  if (account.branchId !== branchId) {
    throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account does not belong to the current branch');
  }
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
  if (p.paymentMethod === 'bank' && p.bankAccountId === null) {
    throw new ValidationError('bank_account_id is required for bank transfer payments');
  }

  const paymentId = await withTransaction({}, async (tx) => {
    // The money comes in at the session branch, which must be the order's (checkCanPay).
    if (p.paymentMethod === 'bank' && p.bankAccountId !== null) await checkBankAccount(tx, p.bankAccountId, actor.branchId);
    const order = foundOrder(await payments.findOrder(tx, p.orderId, { forUpdate: true }));
    const total = policy.checkCanPay(order, actor.branchId, p.amount, await payments.takings(tx, order.id));
    await checkNotWrittenOff(tx, 'order_credit_sale', order.id);

    const reference = await nextDailyNumber(tx, 'PAY');
    if (p.paymentMethod === 'store_credit') await checkStoreCredit(tx, order, p.amount);
    if (p.paymentMethod === 'loyalty_points') await spendPoints(tx, order, p.amount, reference);

    const id = await payments.insertPayment(tx, { ...p, reference, processedBy: actor.staffId });
    if (p.paymentMethod === 'store_credit') {
      await customers.moveStoreCredit(tx, order.customerId as number, p.amount, { direction: 'debit', refType: 'order_payment', refId: id });
    }
    if (p.paymentMethod === 'bank' && p.bankAccountId !== null) {
      await payments.insertBankReconciliation(tx, { bankAccountId: p.bankAccountId, amount: p.amount, paymentId: id });
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
export async function refund(actor: Actor, paymentId: string, r: NewRefund): Promise<RefundRecord> {
  return withTransaction({}, async (tx) => {
    const payment = await payments.findPayment(tx, paymentId, { forUpdate: true });
    if (!payment) throw new NotFoundError('Payment');
    const order = foundOrder(await payments.findOrder(tx, payment.orderId, { forUpdate: true }));
    const earlier = Money.sum((await payments.refundsOf(tx, payment.id)).map((x) => x.refundAmount));
    policy.checkCanRefund(payment, earlier, r.refundAmount);
    // A written-off debt is closed: refunding would make it owed again.
    await checkNotWrittenOff(tx, 'order_credit_sale', order.id);
    const bankAccountId = policy.refundBankAccount(payment, r.bankAccountId);
    if (bankAccountId !== null) await checkBankAccount(tx, bankAccountId, order.branchId);

    const refund = await payments.insertRefund(tx, {
      payment,
      amount: r.refundAmount,
      reason: r.reason,
      bankAccountId,
      processedBy: actor.staffId,
    });
    if (bankAccountId !== null) {
      await payments.insertBankReconciliation(tx, { bankAccountId, amount: r.refundAmount, refundId: refund.id });
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
