import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { getMaxReturnValueWithoutAuth, getRefundMethodAfterWindow, getReturnWindowDays } from '../config/config.service.js';
import * as customers from '../customer/customer.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { assertAssignedLocation } from '../location/location.service.js';
import { creditReturn } from '../receivables/receivables.service.js';
import * as policy from './returns.policy.js';
import * as returns from './returns.repository.js';
import type { Actor, Paging, RefundPart, ReturnFilter, ReturnLineRequest, ReturnRecord, SaleForReturn, SaleLine } from './returns.types.js';

/**
 * Use cases of returns (A4): books brought back from a counter sale. One
 * function each, owning its transaction.
 */

function found(r: ReturnRecord | undefined): ReturnRecord {
  if (r === undefined) throw new NotFoundError('Return');
  return r;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<ReturnRecord> {
  const r = found(await returns.findReturn(kysely, id));
  const [lineItems, refunds] = await Promise.all([returns.returnLines(kysely, id), returns.refunds(kysely, id)]);
  return { ...r, lineItems, refunds };
}

export function list(filter: ReturnFilter, paging: Paging): Promise<{ items: ReturnRecord[]; total: number }> {
  return returns.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Returning books ───────────────────────────────────────────────────────────

interface ValuedLine {
  line: SaleLine;
  quantity: number;
  disposition: ReturnLineRequest['disposition'];
  value: Money;
}

/** Values each requested line against what is left of it; a line named twice counts once for both. */
function valueLines(saleLines: SaleLine[], requested: ReturnLineRequest[]): ValuedLine[] {
  const byId = new Map(saleLines.map((l) => [l.id, { ...l }]));
  return requested.map((r) => {
    const line = byId.get(String(r.transactionLineItemId));
    if (!line) throw new NotFoundError(`Transaction line item ${r.transactionLineItemId}`);
    const value = policy.lineValue(line, r.quantity);
    line.returnedQuantity += r.quantity;
    line.returnedValue = line.returnedValue.plus(value);
    return { line, quantity: r.quantity, disposition: r.disposition, value };
  });
}

/** Store credit and points go back to the customer's account; cash, bank and mobile are handed back. */
async function payBack(q: Queryable, sale: SaleForReturn, returnId: string, parts: RefundPart[]): Promise<void> {
  if (sale.customerId === null) return;
  for (const p of parts) {
    if (p.method === 'store_credit') {
      await customers.moveStoreCredit(q, sale.customerId, p.amount, { direction: 'credit', refType: 'return', refId: returnId });
    }
    if (p.method === 'loyalty_points') {
      await customers.addPoints(q, sale.customerId, p.amount.toNumber(), { reason: 'REFUND', transactionRef: sale.transactionNumber });
    }
  }
}

/** Takes back the points the returned part of the sale earned, as far as the balance allows. */
async function reversePoints(q: Queryable, sale: SaleForReturn, returnedValue: Money): Promise<void> {
  if (sale.customerId === null) return;
  const { earned, reversed } = await returns.salePoints(q, sale.customerId, sale.transactionNumber);
  const due = policy.pointsToTakeBack({ earned, reversed, returnedValue, grandTotal: sale.grandTotal });
  if (due <= 0) return;
  const balance = (await customers.lockPoints(q, sale.customerId)) ?? 0;
  const takeBack = Math.min(due, Math.max(0, balance));
  if (takeBack > 0) {
    await customers.addPoints(q, sale.customerId, -takeBack, { reason: 'RETURN_REVERSAL', transactionRef: sale.transactionNumber });
  }
}

/**
 * A return against a counter sale, in its own branch (owner decision 4a).
 * The sale is locked, so returns on it run one after another and never take
 * back more than was sold. The books go back to stock at the cost they left
 * at (damaged ones are kept apart). Their value is first set against what
 * the customer still owes on the sale, as a credit note (1a); the rest goes
 * back the way the sale was paid (2a). Above the approval limit only a
 * Manager or Admin can process it (3a).
 */
export async function createReturn(
  actor: Actor,
  input: { transactionId: number; reason: string | null; lines: ReturnLineRequest[] },
): Promise<ReturnRecord> {
  const id = await withTransaction({}, async (tx) => {
    const sale = await returns.lockSale(tx, input.transactionId);
    if (!sale) throw new NotFoundError('Transaction');
    policy.checkSale(sale, actor.branchId);
    await assertAssignedLocation(sale.locationId, actor);

    const lines = valueLines(await returns.saleLines(tx, sale.id), input.lines);
    const total = Money.sum(lines.map((l) => l.value));
    const maxWithoutAuth = Money.of(await getMaxReturnValueWithoutAuth());
    policy.checkApproval(total, maxWithoutAuth, actor.role);

    const credited = sale.amountDue.greaterThan(0)
      ? await creditReturn(tx, { sourceType: 'pos_credit_sale', sourceEntityId: sale.id, amount: total })
      : Money.ZERO;
    if (credited.greaterThan(0)) {
      const after = policy.saleAfterCredit(sale, credited);
      await returns.setSaleDue(tx, sale.id, after.due, after.status);
    }

    const storeCreditOnly = policy.storeCreditOnly(
      sale.daysSinceSale,
      await getReturnWindowDays(sale.branchId),
      await getRefundMethodAfterWindow(),
    );
    const refunded = policy.allocateRefund(total.minus(credited), await returns.tenders(tx, sale.id), {
      storeCreditOnly,
      hasCustomer: sale.customerId !== null,
      paidLeft: sale.amountPaid.minus(await returns.refundedSoFar(tx, sale.id)),
    });
    const parts: RefundPart[] = credited.greaterThan(0) ? [{ method: 'credit_note', amount: credited }, ...refunded] : refunded;
    const refundMethod = policy.refundMethodOf(parts);

    for (const l of lines) {
      const change = {
        bookId: l.line.bookId,
        locationId: sale.locationId,
        quantity: l.quantity,
        referenceType: 'pos_return',
        referenceId: sale.id,
        staffCtx: actor,
      };
      if (l.disposition === 'DAMAGED') {
        await inventoryService.receiveDamaged(tx, { ...change, reasonCode: 'damage', notes: `Damaged return – ${l.quantity} unit(s)` });
      } else {
        // At the cost the books left at, not today's average (the return posting rule).
        const unitCost = l.line.unitCost !== null && l.line.unitCost.greaterThan(0) ? l.line.unitCost : undefined;
        await inventoryService.receiveStock(tx, { ...change, reasonCode: 'return', notes: `Return of ${l.quantity} unit(s)`, unitCost });
      }
    }

    const returnNumber = await nextDailyNumber(tx, 'RET');
    const aboveLimit = total.greaterThan(maxWithoutAuth);
    const returnId = await returns.insertReturn(tx, {
      returnNumber,
      transactionId: sale.id,
      branchId: sale.branchId,
      customerId: sale.customerId,
      total,
      refundMethod,
      reason: input.reason,
      processedBy: actor.staffId,
      // Above the limit, the Manager or Admin who processed it approved it.
      approvedBy: aboveLimit ? actor.staffId : null,
    });
    for (const l of lines) {
      await returns.insertLine(tx, returnId, {
        transactionLineItemId: l.line.id,
        bookId: l.line.bookId,
        quantity: l.quantity,
        unitPrice: l.line.unitPrice,
        value: l.value,
      });
    }
    for (const p of parts) await returns.insertRefund(tx, returnId, p);

    await payBack(tx, sale, returnId, refunded);
    // What all returns on the sale took back, this one included.
    await reversePoints(tx, sale, Money.sum((await returns.saleLines(tx, sale.id)).map((l) => l.returnedValue)));

    await insertAuditEntry(tx, {
      staffId: actor.staffId,
      staffRole: actor.role,
      branchId: actor.branchId,
      action: 'CREATE',
      entityType: 'return',
      entityId: returnId,
      meta: {
        returnNumber,
        transactionId: sale.id,
        totalRefundAmount: total.toNumber(),
        refundMethod,
        refunds: parts.map((p) => ({ method: p.method, amount: p.amount.toNumber() })),
      },
    });
    await insertOutboxEvent(tx, 'return.initiated', {
      returnId, returnNumber, txNumber: sale.transactionNumber, branchId: sale.branchId, amount: total.toNumber(),
    });
    return returnId;
  });
  return getById(id);
}
