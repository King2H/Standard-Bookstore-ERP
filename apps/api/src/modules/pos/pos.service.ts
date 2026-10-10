import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { getMaxLineDiscountPct } from '../config/config.service.js';
import * as customers from '../customer/customer.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import {
  cancelReceivable,
  checkNotWrittenOff,
  createReceivable,
  updateReceivableOnPayment,
} from '../receivables/receivables.service.js';
import * as policy from './pos.policy.js';
import * as pos from './pos.repository.js';
import type { Actor, NewSale, Paging, PaymentLine, PosFilter, PosTransactionRecord, PricedLine } from './pos.types.js';

/**
 * Use cases of counter sales (A4): selling, collecting what a credit sale
 * still owes, and voiding a sale on its day. One function each, owning its
 * transaction.
 */

function audit(q: Queryable, actor: Actor, action: string, id: string, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'transaction',
    entityId: id,
    meta,
  });
}

function found(t: PosTransactionRecord | undefined): PosTransactionRecord {
  if (t === undefined) throw new NotFoundError('Transaction');
  return t;
}

function sumOf(payments: PaymentLine[]): Money {
  return Money.sum(payments.map((p) => p.amount));
}

/** Spends store credit and loyalty points the customer pays with, each checked under lock. */
async function spendFromAccounts(q: Queryable, customerId: number | null, payments: PaymentLine[], ref: { id: string; number: string; refType: string }) {
  if (customerId === null) return;
  for (const p of payments) {
    if (p.method === 'store_credit') {
      const available = (await customers.lockStoreCredit(q, customerId)) ?? Money.ZERO;
      if (available.lessThan(p.amount)) {
        throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Insufficient store credit balance', {
          available: available.toNumber(),
          requested: p.amount.toNumber(),
        });
      }
      await customers.moveStoreCredit(q, customerId, p.amount, { direction: 'debit', refType: ref.refType, refId: ref.id });
    }
    if (p.method === 'loyalty_points') {
      const available = (await customers.lockPoints(q, customerId)) ?? 0;
      if (Money.of(available).lessThan(p.amount)) {
        throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Insufficient loyalty points balance', {
          available,
          requested: p.amount.toNumber(),
        });
      }
      await customers.addPoints(q, customerId, -p.amount.toNumber(), { reason: 'REDEMPTION', transactionRef: ref.number });
    }
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<PosTransactionRecord> {
  const t = found(await pos.findTransaction(kysely, id));
  const [lineItems, payments] = await Promise.all([pos.lineItems(kysely, id), pos.payments(kysely, id)]);
  return { ...t, lineItems, payments };
}

export function list(filter: PosFilter, paging: Paging): Promise<{ items: PosTransactionRecord[]; total: number }> {
  return pos.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Selling ───────────────────────────────────────────────────────────────────

async function priceLines(q: Queryable, sale: NewSale): Promise<PricedLine[]> {
  const lines: PricedLine[] = [];
  for (const item of sale.items) {
    const book = await pos.bookForSale(q, item.bookId, sale.branchId);
    if (!book) throw new NotFoundError(`Book ${item.bookId}`);
    if (!book.isActive) throw new BusinessError('BOOK_INACTIVE', `Book ${item.bookId} is not active`);
    if (book.price === null) throw new BusinessError('PRICE_NOT_SET', `Price not set for book ${item.bookId}`);
    lines.push(policy.priceLine(item, book.price));
  }
  return lines;
}

/**
 * A counter sale: the books leave stock at their average cost, the payments
 * are taken, and a credit sale's unpaid rest becomes the customer's
 * receivable, in one transaction. The receivable is no longer optional: a
 * sale that cannot record its debt does not happen.
 */
export async function createTransaction(actor: Actor, sale: NewSale): Promise<PosTransactionRecord> {
  policy.checkTender(sale.payments, sale.customerId);

  const id = await withTransaction({}, async (tx) => {
    if (!(await pos.isBranchActive(tx, sale.branchId))) {
      throw new BusinessError('BRANCH_INACTIVE', 'This branch is inactive and cannot process transactions');
    }
    if (sale.customerId !== null && !(await pos.isCustomerActive(tx, sale.customerId))) {
      throw new BusinessError('CUSTOMER_INACTIVE', 'This customer account is inactive');
    }

    const lines = await priceLines(tx, sale);
    policy.checkDiscounts(lines, await getMaxLineDiscountPct(sale.branchId, actor.role));
    const totals = policy.totals(lines);
    const paid = sumOf(sale.payments);
    policy.checkSalePayments(
      { grandTotal: totals.grandTotal, paid, allowCredit: sale.allowCredit, customerId: sale.customerId, dueDate: sale.dueDate },
      await pos.today(tx),
    );
    const status = policy.paymentStatus(totals.grandTotal, paid);
    const due = policy.amountDue(totals.grandTotal, paid);
    const transactionNumber = await nextDailyNumber(tx, 'POS');

    const id = await pos.insertTransaction(tx, {
      branchId: sale.branchId,
      locationId: sale.locationId,
      customerId: sale.customerId,
      staffId: actor.staffId,
      transactionNumber,
      ...totals,
      amountPaid: paid,
      amountDue: due,
      paymentStatus: status,
    });

    // Each line is posted at the average cost it leaves stock at, frozen on the line.
    for (const line of lines) {
      const { unitCost } = await inventoryService.issueStock(tx, {
        bookId: line.bookId,
        locationId: sale.locationId,
        quantity: line.quantity,
        referenceType: 'sale',
        referenceId: id,
        staffCtx: actor,
      });
      await pos.insertLine(tx, id, line, unitCost);
    }
    await spendFromAccounts(tx, sale.customerId, sale.payments, { id, number: transactionNumber, refType: 'transaction' });
    for (const p of sale.payments) await pos.insertPayment(tx, id, p);

    if (sale.customerId !== null && status !== 'credit' && sale.payments.length > 0) {
      await insertOutboxEvent(tx, 'LoyaltyAccrualRequested', {
        customerId: sale.customerId,
        transactionRef: transactionNumber,
        subtotal: totals.subtotal.toNumber(),
        branchId: sale.branchId,
      });
    }
    if (sale.customerId !== null && due.greaterThan(0)) {
      await createReceivable(tx, {
        sourceType: 'pos_credit_sale',
        sourceRefId: transactionNumber,
        sourceEntityId: Number(id),
        customerId: sale.customerId,
        branchId: sale.branchId,
        originalAmount: due.toFixed(2),
        dueDate: sale.dueDate,
      });
    }

    await audit(tx, actor, 'CREATE', id, {
      transactionNumber,
      grandTotal: totals.grandTotal.toNumber(),
      amountPaid: paid.toNumber(),
      amountDue: due.toNumber(),
      paymentStatus: status,
      itemCount: lines.length,
    });
    if (status === 'paid') {
      await insertOutboxEvent(tx, 'pos.sale_completed', {
        txId: id, txNumber: transactionNumber, branchId: sale.branchId, amount: totals.grandTotal.toNumber(),
      });
    } else {
      await insertOutboxEvent(tx, 'pos.credit_sale', {
        txId: id,
        txNumber: transactionNumber,
        branchId: sale.branchId,
        amountDue: due.toNumber(),
        customerId: sale.customerId,
        customerName: sale.customerId === null ? null : await pos.customerName(tx, sale.customerId),
      });
    }
    return id;
  });
  return getById(id);
}

// ── Collecting what a credit sale still owes ─────────────────────────────────

/**
 * A later payment on a credit or part-paid sale. The sale is locked, so two
 * collections at once cannot together pay more than is due.
 */
export async function recordPayment(actor: Actor, txId: string, payments: PaymentLine[]): Promise<PosTransactionRecord> {
  await withTransaction({}, async (tx) => {
    const t = found(await pos.findTransaction(tx, txId, { forUpdate: true }));
    const incoming = sumOf(payments);
    policy.checkCanCollect(t, incoming);
    policy.checkTender(payments, t.customerId);
    // A written-off debt is closed; locks the receivable against a concurrent write-off.
    await checkNotWrittenOff(tx, 'pos_credit_sale', t.id);

    await spendFromAccounts(tx, t.customerId, payments, { id: t.id, number: t.transactionNumber, refType: 'payment' });
    for (const p of payments) await pos.insertPayment(tx, t.id, p);
    const paid = t.amountPaid.plus(incoming);
    const { due, status } = policy.afterCollect(t.amountDue, incoming);
    await pos.setPaid(tx, t.id, paid, due, status);
    await updateReceivableOnPayment(tx, {
      sourceType: 'pos_credit_sale',
      sourceEntityId: Number(t.id),
      newOutstandingAmount: due.toFixed(2),
      isFullySettled: status === 'paid',
    });

    if (t.customerId !== null && status === 'paid') {
      await insertOutboxEvent(tx, 'LoyaltyAccrualRequested', {
        customerId: t.customerId,
        transactionRef: t.transactionNumber,
        subtotal: t.subtotal.toNumber(),
        branchId: actor.branchId,
      });
    }
    await audit(tx, actor, 'UPDATE', t.id, {
      action: 'record_payment',
      incoming: incoming.toNumber(),
      newAmountDue: due.toNumber(),
      newPaymentStatus: status,
    });
    await insertOutboxEvent(tx, 'pos.payment_collected', {
      txId: t.id, txNumber: t.transactionNumber, branchId: actor.branchId, amount: incoming.toNumber(),
    });
  });
  return getById(txId);
}

// ── Voiding a sale ────────────────────────────────────────────────────────────

/**
 * Cancels a sale on the day it was made, while nothing on it was returned
 * (owner decision 1a). The books go back at the cost they left at, every
 * payment goes back the way it was paid (store credit and points to the
 * customer's account; cash, mobile and bank handed back, recorded in the
 * audit entry), points the sale earned are taken back, and a credit sale's
 * receivable is cancelled. The sale is locked, so two voids cannot both
 * restore its stock.
 */
export async function voidTransaction(actor: Actor, txId: string): Promise<PosTransactionRecord> {
  await withTransaction({}, async (tx) => {
    const t = found(await pos.findTransaction(tx, txId, { forUpdate: true }));
    policy.checkCanVoid(t);
    await cancelReceivable(tx, { sourceType: 'pos_credit_sale', sourceEntityId: t.id, paymentsReturned: true });

    for (const line of await pos.lineItems(tx, t.id)) {
      await inventoryService.receiveStock(tx, {
        bookId: line.bookId,
        locationId: t.locationId,
        quantity: line.quantity,
        referenceType: 'void',
        referenceId: t.id,
        reasonCode: 'return',
        staffCtx: actor,
        unitCost: line.unitCost !== null && line.unitCost.greaterThan(0) ? line.unitCost : undefined,
      });
    }

    const payments = await pos.payments(tx, t.id);
    if (t.customerId !== null) {
      for (const p of payments) {
        if (p.method === 'store_credit') {
          await customers.moveStoreCredit(tx, t.customerId, p.amount, { direction: 'credit', refType: 'transaction_void', refId: t.id });
        }
        if (p.method === 'loyalty_points') {
          await customers.addPoints(tx, t.customerId, p.amount.toNumber(), { reason: 'VOID_REVERSAL', transactionRef: t.transactionNumber });
        }
      }
      const earned = await pos.pointsEarned(tx, t.customerId, t.transactionNumber);
      if (earned > 0) {
        const balance = (await customers.lockPoints(tx, t.customerId)) ?? 0;
        const takeBack = Math.min(earned, Math.max(0, balance));
        if (takeBack > 0) {
          await customers.addPoints(tx, t.customerId, -takeBack, { reason: 'VOID_REVERSAL', transactionRef: t.transactionNumber });
        }
      }
    }

    await pos.setVoided(tx, t.id);
    const handedBack: Record<string, number> = {};
    for (const p of payments) handedBack[p.method] = Money.of(handedBack[p.method] ?? 0).plus(p.amount).toNumber();
    await audit(tx, actor, 'UPDATE', t.id, { action: 'void', transactionNumber: t.transactionNumber, paymentsReturned: handedBack });
    await insertOutboxEvent(tx, 'pos.transaction_voided', {
      txId: t.id,
      txNumber: t.transactionNumber,
      branchId: t.branchId,
      staffId: actor.staffId,
      staffName: (await pos.staffName(tx, actor.staffId)) ?? String(actor.staffId),
    });
  });
  return getById(txId);
}
