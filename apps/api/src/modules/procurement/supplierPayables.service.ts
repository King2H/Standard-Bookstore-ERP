import type { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { poNumber } from './procurement.mapper.js';
import * as orderPolicy from './procurement.policy.js';
import * as orders from './procurement.repository.js';
import { getById, refreshFinancialStatus } from './procurement.service.js';
import type { Actor, PurchaseOrderRecord } from './procurement.types.js';
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
  payment: { amount: Money; paymentMethod: string; notes: string | null },
): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOwnOrder(tx, actor, poId);
    policy.checkPayable(po.status);
    await checkWithinOrder(tx, po, payment.amount);
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
    });
    await refreshFinancialStatus(tx, poId);
    await audit(tx, actor, 'supplier_payment', id, {
      paymentNumber, poNumber: poNumber(poId), amount: payment.amount.toNumber(), paymentMethod: payment.paymentMethod,
    });
  });
  return getById(poId);
}

/** A payment recorded by mistake stops counting; it stays on record as reversed (owner decision 1a). */
export async function reversePayment(actor: Actor, poId: string, paymentId: number, reason: string): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    await lockOwnOrder(tx, actor, poId);
    const payment = await payables.lockPayment(tx, poId, paymentId);
    if (!payment) throw new NotFoundError('Supplier payment');
    policy.checkCanReverse(payment);
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
export async function recordCreditNote(actor: Actor, poId: string, credit: { amount: Money; reason: string }): Promise<PurchaseOrderRecord> {
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

/** The supplier's ledger for one branch's orders, or every branch's when `branchId` is undefined. */
export async function ledger(
  supplierId: number,
  branchId: number | undefined,
  range: { dateFrom?: string; dateTo?: string },
): Promise<ReturnType<typeof policy.buildLedger>> {
  if (!(await payables.supplierExists(kysely, supplierId))) throw new NotFoundError('Supplier');
  return policy.buildLedger(await payables.ledgerEvents(kysely, supplierId, branchId), range);
}
