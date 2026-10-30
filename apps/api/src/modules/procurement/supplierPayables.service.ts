import type { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { accountForPayment, cancelMovement, recordMovement } from '../bankAccount/bankAccount.service.js';
import { poNumber, refundDueOf } from './procurement.mapper.js';
import * as orderPolicy from './procurement.policy.js';
import * as orders from './procurement.repository.js';
import { getById, refreshFinancialStatus } from './procurement.service.js';
import type { Actor, PurchaseOrderRecord, PurchaseOrderView } from './procurement.types.js';
import * as policy from './supplierPayables.policy.js';
import * as payables from './supplierPayables.repository.js';

/**
 * Use cases of supplier payables (A4): paying a supplier for an order,
 * reversing a mistaken payment, a supplier's credit note, and the supplier
 * ledger. Each write locks the order, so two people paying it at once take
 * turns and cannot together pay more than it is worth.
 */

function audit(q: Queryable, actor: Actor, entityType: string, entityId: string, meta: Record<string, unknown>, action = 'CREATE') {
  return insertAuditEntry(q, { staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action, entityType, entityId, meta });
}

/** The order, locked, in the ordering branch, which pays (owner decision 1a). */
async function lockOwnOrder(q: Queryable, actor: Actor, poId: string): Promise<PurchaseOrderRecord> {
  const po = await orders.findOrder(q, poId, { forUpdate: true });
  if (!po) throw new NotFoundError('Purchase Order');
  orderPolicy.checkOrderingBranch(po, actor);
  return po;
}

async function checkWithinOrder(q: Queryable, po: PurchaseOrderRecord, amount: Money): Promise<void> {
  const { settled } = await orders.settlement(q, po.id);
  policy.checkWithinOrderTotal(po.totalAmount, settled, amount);
}

export async function recordPayment(
  actor: Actor,
  poId: string,
  payment: { amount: Money; paymentMethod: string; notes: string | null; bankAccountId?: number | null },
): Promise<PurchaseOrderView> {
  await withTransaction({}, async (tx) => {
    const po = await lockOwnOrder(tx, actor, poId);
    policy.checkPayable(po.status);
    await checkWithinOrder(tx, po, payment.amount);
    // With bank accounts on, a bank payment names an active account of the ordering branch (#21).
    const bankAccountId = payment.paymentMethod === 'bank' ? await accountForPayment(tx, payment.bankAccountId ?? null, po.branchId) : null;
    const paymentNumber = await nextDailyNumber(tx, 'SPAY');
    const id = await orders.insertSupplierPayment(tx, {
      paymentNumber,
      poId,
      branchId: po.branchId,
      supplierId: po.supplierId,
      amount: payment.amount,
      paymentMethod: payment.paymentMethod,
      source: 'manual',
      notes: payment.notes,
      createdBy: actor.staffId,
      bankAccountId,
    });
    if (bankAccountId !== null) {
      await recordMovement(tx, {
        bankAccountId, direction: 'out', amount: payment.amount, sourceType: 'supplier_payment', sourceId: id, notes: `Supplier payment ${paymentNumber}`,
      });
    }
    await refreshFinancialStatus(tx, poId);
    await audit(tx, actor, 'supplier_payment', id, {
      paymentNumber, poNumber: poNumber(poId), amount: payment.amount.toNumber(), paymentMethod: payment.paymentMethod,
    });
  });
  return getById(poId);
}

/** A payment recorded by mistake stops counting; it stays on record as reversed (owner decision 1a). */
export async function reversePayment(actor: Actor, poId: string, paymentId: number, reason: string): Promise<PurchaseOrderView> {
  await withTransaction({}, async (tx) => {
    await lockOwnOrder(tx, actor, poId);
    const payment = await payables.lockPayment(tx, poId, paymentId);
    if (!payment) throw new NotFoundError('Supplier payment');
    policy.checkCanReverse(payment);
    // Money that never left takes its bank movement with it; refused once matched to the statement.
    await cancelMovement(tx, 'supplier_payment', String(payment.id));
    await payables.reversePayment(tx, payment.id, actor.staffId, reason);
    await refreshFinancialStatus(tx, poId);
    await audit(
      tx,
      actor,
      'supplier_payment',
      payment.id,
      { action: 'reverse', paymentNumber: payment.paymentNumber, poNumber: poNumber(poId), amount: payment.amount.toNumber(), reason },
      'UPDATE',
    );
  });
  return getById(poId);
}

/** The supplier's credit against an order: damaged goods, an overcharge, a negotiated price. */
export async function recordCreditNote(actor: Actor, poId: string, credit: { amount: Money; reason: string }): Promise<PurchaseOrderView> {
  await withTransaction({}, async (tx) => {
    const po = await lockOwnOrder(tx, actor, poId);
    policy.checkCreditable(po.status);
    await checkWithinOrder(tx, po, credit.amount);
    const creditNoteNumber = await nextDailyNumber(tx, 'SCN');
    const id = await payables.insertCreditNote(tx, {
      creditNoteNumber,
      poId,
      supplierId: po.supplierId,
      branchId: po.branchId,
      amount: credit.amount,
      reason: credit.reason,
      createdBy: actor.staffId,
    });
    await refreshFinancialStatus(tx, poId);
    await audit(tx, actor, 'supplier_credit_note', id, {
      creditNoteNumber, poNumber: poNumber(poId), amount: credit.amount.toNumber(), reason: credit.reason,
    });
  });
  return getById(poId);
}

/**
 * Money the supplier pays back once a return credited beyond what the order
 * owed (#173, decision 4a): recorded by the ordering branch when it arrives,
 * at most the refund due; a bank refund comes into an account of the branch.
 */
export async function recordRefund(
  actor: Actor,
  poId: string,
  refund: { amount: Money; method: string; reference: string | null; notes: string | null; bankAccountId: number | null },
): Promise<PurchaseOrderView> {
  await withTransaction({}, async (tx) => {
    const po = await lockOwnOrder(tx, actor, poId);
    policy.checkWithinRefundDue(refundDueOf(po), refund.amount);
    const bankAccountId = refund.method === 'bank' ? await accountForPayment(tx, refund.bankAccountId, po.branchId) : null;
    const refundNumber = await nextDailyNumber(tx, 'SREF');
    const id = await payables.insertRefund(tx, {
      refundNumber, poId, branchId: po.branchId, supplierId: po.supplierId, amount: refund.amount, method: refund.method,
      reference: refund.reference, bankAccountId, notes: refund.notes, createdBy: actor.staffId,
    });
    if (bankAccountId !== null) {
      await recordMovement(tx, {
        bankAccountId, direction: 'in', amount: refund.amount, sourceType: 'supplier_refund', sourceId: String(id),
        notes: [`Supplier refund ${refundNumber}`, refund.reference].filter(Boolean).join(' · '),
      });
    }
    await refreshFinancialStatus(tx, poId);
    await audit(tx, actor, 'supplier_refund', String(id), {
      refundNumber, poNumber: poNumber(poId), amount: refund.amount.toFixed(2), method: refund.method, reference: refund.reference,
    });
  });
  return getById(poId);
}

/**
 * The credit note a return to supplier creates when it is sent (#173,
 * decision 4a), in the caller's transaction with the order locked: at the
 * order's price and outside the ordered-total cap, since the copies came
 * back; what it credits beyond what the order owes is a refund due.
 */
export async function creditForReturn(
  tx: Queryable,
  actor: Actor,
  po: PurchaseOrderRecord,
  credit: { amount: Money; returnNumber: string },
): Promise<{ id: number; creditNoteNumber: string }> {
  const creditNoteNumber = await nextDailyNumber(tx, 'SCN');
  const reason = `Return ${credit.returnNumber}`;
  const id = await payables.insertCreditNote(tx, {
    creditNoteNumber, poId: po.id, supplierId: po.supplierId, branchId: po.branchId, amount: credit.amount, reason, createdBy: actor.staffId,
  });
  await refreshFinancialStatus(tx, po.id);
  await audit(tx, actor, 'supplier_credit_note', id, { creditNoteNumber, poNumber: poNumber(po.id), amount: credit.amount.toNumber(), reason });
  return { id: Number(id), creditNoteNumber };
}

/** The supplier's ledger for one branch's orders, or every branch's when `branchId` is undefined. */
export async function ledger(
  supplierId: number,
  branchId: number | undefined,
  range: { dateFrom?: string; dateTo?: string },
): Promise<ReturnType<typeof policy.buildLedger>> {
  if (!(await payables.supplierExists(kysely, supplierId))) throw new NotFoundError('Supplier');
  return policy.buildLedger(await payables.ledgerEvents(kysely, supplierId, branchId), range);
}
