import { randomUUID } from 'node:crypto';
import { Money, type MoneyInput } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { validateBankAccountForBranch } from '../bankAccount/bankAccount.service.js';
import * as customers from '../customer/customer.repository.js';
import * as policy from './receivables.policy.js';
import * as receivables from './receivables.repository.js';
import type {
  Actor,
  Paging,
  PaymentCollection,
  ReceivableFilter,
  ReceivableRecord,
  ReceivableSourceType,
  ReceivableSummaryRecord,
} from './receivables.types.js';

/**
 * Use cases of receivables (A4): what customers owe on credit sales and
 * Customer_Pays exchanges. Sales, payments, returns and exchanges open and
 * pay them down with createReceivable() and updateReceivableOnPayment(),
 * inside their own transaction; the rest are the Receivables page's actions.
 *
 * Collecting on an order or a POS sale goes through that sale's own payment
 * flow (the controller dispatches), so this module never imports payments or
 * POS.
 */

function audit(q: Queryable, actor: Actor, action: string, entityType: string, id: string, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType,
    entityId: id,
    meta,
  });
}

function found(record: ReceivableRecord | undefined): ReceivableRecord {
  if (record === undefined) throw new NotFoundError('Receivable');
  return record;
}

// ── Called by the flows that create and pay down debt, in their transaction ──

/** Opens the receivable for what a customer still owes; nothing when they owe nothing. */
export async function createReceivable(
  q: Queryable,
  data: {
    sourceType: ReceivableSourceType;
    sourceRefId: string;
    sourceEntityId: number;
    customerId: number;
    branchId: number;
    originalAmount: MoneyInput;
    dueDate?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  const originalAmount = Money.of(data.originalAmount).round(2);
  if (!originalAmount.greaterThan(0)) return;
  await receivables.insert(q, {
    ...data,
    originalAmount,
    dueDate: data.dueDate ?? null,
    notes: data.notes ?? null,
  });
}

/**
 * Records what is left to pay after a payment, refund or exchange reduced
 * the debt. A receivable that is already closed (paid, written off) or whose
 * order was cancelled does not change.
 */
export async function updateReceivableOnPayment(
  q: Queryable,
  opts: {
    sourceType: ReceivableSourceType;
    sourceEntityId: number;
    /** Remaining amount owed after this payment; below zero counts as zero. */
    newOutstandingAmount: MoneyInput;
    isFullySettled: boolean;
  },
): Promise<void> {
  const r = await receivables.lockBySource(q, opts.sourceType, opts.sourceEntityId);
  if (!r || !policy.isOpen(r.status)) return;
  if (opts.sourceType === 'order_credit_sale') {
    const status = await receivables.orderStatus(q, opts.sourceEntityId);
    if (status?.toUpperCase() === 'CANCELLED') return;
  }
  const outstanding = Money.max(0, Money.of(opts.newOutstandingAmount).round(2));
  const status = policy.statusAfterPayment(r, outstanding, opts.isFullySettled, await receivables.today(q));
  await receivables.setBalance(q, r.id, status === 'Settled' ? Money.ZERO : outstanding, status);
}

/**
 * Refuses a payment against a sale whose receivable was written off. Call it
 * inside the payment's transaction: it locks the receivable, so a write-off
 * and a payment never pass each other.
 */
export async function checkNotWrittenOff(q: Queryable, sourceType: ReceivableSourceType, sourceEntityId: number | string): Promise<void> {
  const r = await receivables.lockBySource(q, sourceType, sourceEntityId);
  if (r?.status === 'WrittenOff') policy.checkOpen(r);
}

/** The scheduled job: open receivables past their due date become Overdue. */
export function markOverdueReceivables(): Promise<number> {
  return receivables.markOverdue(kysely);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<ReceivableRecord> {
  return found(await receivables.findById(kysely, id));
}

export async function list(filter: ReceivableFilter, paging: Paging): Promise<{ items: ReceivableRecord[]; total: number }> {
  return receivables.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

/** Undefined `branchId`: every branch, for staff with access to all branches. */
export function getSummary(branchId: number | undefined): Promise<ReceivableSummaryRecord> {
  return receivables.summary(kysely, branchId);
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Records a payment against a receivable with no payment flow of its own:
 * an exchange difference. Booked in the ledger, which the Payments report
 * reads, and for bank transfers queued for reconciliation.
 */
export async function collectPayment(actor: Actor, id: string, payment: PaymentCollection): Promise<ReceivableRecord> {
  if (payment.paymentMethod === 'bank') {
    if (payment.bankAccountId === null) throw new ValidationError('bankAccountId is required for bank transfer payments');
    await validateBankAccountForBranch(payment.bankAccountId, actor.branchId);
  }

  await withTransaction({}, async (tx) => {
    const r = found(await receivables.findById(tx, id, { forUpdate: true }));
    policy.checkCanCollect(r, payment.amount);

    if (payment.paymentMethod === 'store_credit') {
      const available = (await customers.lockStoreCredit(tx, r.customerId)) ?? Money.ZERO;
      if (available.lessThan(payment.amount)) {
        throw new BusinessError(
          'INSUFFICIENT_STORE_CREDIT',
          `Insufficient store credit. Available: ETB ${available.toFixed()}, requested: ETB ${payment.amount.toFixed()}`,
          { available: available.toNumber(), requested: payment.amount.toNumber() },
        );
      }
      await customers.moveStoreCredit(tx, r.customerId, payment.amount, {
        direction: 'debit',
        refType: 'receivable_payment',
        refId: r.id,
      });
    }

    const entryId = await receivables.insertLedgerEntry(tx, {
      type: 'payment',
      receivable: r,
      idempotencyKey: `receivable-${r.id}-${randomUUID()}`,
      amount: payment.amount,
      method: payment.paymentMethod,
      staffId: actor.staffId,
      meta: { receivableId: r.id, sourceType: r.sourceType, notes: payment.notes },
    });
    if (payment.paymentMethod === 'bank' && payment.bankAccountId !== null) {
      await receivables.insertBankReconciliation(tx, {
        bankAccountId: payment.bankAccountId,
        paymentRefId: entryId,
        amount: payment.amount,
        notes: `Receivable #${r.id} payment`,
      });
    }

    const outstanding = r.outstandingAmount.minus(payment.amount);
    const status = policy.statusAfterPayment(r, outstanding, false, await receivables.today(tx));
    await receivables.setBalance(tx, r.id, outstanding, status);
    await audit(tx, actor, 'CREATE', 'receivable_payment', r.id, {
      amount: payment.amount.toNumber(),
      paymentMethod: payment.paymentMethod,
      notes: payment.notes,
    });
  });
  return getById(id);
}

/**
 * Closes a bad debt without payment (owner decision, #21): the receivable
 * becomes WrittenOff, distinct from Settled, and the amount still owed goes
 * to the ledger as a write_off entry and to the audit log, with the reason.
 * Its sale then leaves Unpaid Orders and takes no further payments.
 */
export async function writeOff(actor: Actor, id: string, reason: string): Promise<ReceivableRecord> {
  await withTransaction({}, async (tx) => {
    const r = found(await receivables.findById(tx, id, { forUpdate: true }));
    const amount = policy.checkCanWriteOff(r);
    await receivables.writeOff(tx, r.id, { amount, staffId: actor.staffId, reason });
    await receivables.insertLedgerEntry(tx, {
      type: 'write_off',
      receivable: r,
      // One write-off per receivable.
      idempotencyKey: `receivable-${r.id}-write-off`,
      amount,
      method: null,
      staffId: actor.staffId,
      meta: { receivableId: r.id, sourceType: r.sourceType, sourceRefId: r.sourceRefId, reason },
    });
    await audit(tx, actor, 'WRITE_OFF', 'receivable', r.id, {
      amount: amount.toNumber(),
      reason,
      previousStatus: r.status,
      sourceType: r.sourceType,
      sourceRefId: r.sourceRefId,
    });
  });
  return getById(id);
}

/**
 * Sets or removes the due date of an open receivable. Its status follows:
 * a date that has passed makes it Overdue, any other date (or none) makes
 * it current again.
 */
export async function changeDueDate(actor: Actor, id: string, dueDate: string | null): Promise<ReceivableRecord> {
  await withTransaction({}, async (tx) => {
    const r = found(await receivables.findById(tx, id, { forUpdate: true }));
    policy.checkOpen(r);
    const status = policy.statusForDueDate(r, dueDate, await receivables.today(tx));
    await receivables.setDueDate(tx, r.id, dueDate, status);
    await audit(tx, actor, 'UPDATE', 'receivable', r.id, {
      action: 'update_due_date',
      previousDueDate: r.dueDate,
      dueDate,
      previousStatus: r.status,
      status,
    });
  });
  return getById(id);
}
