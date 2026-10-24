import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { recordMovement } from '../bankAccount/bankAccount.service.js';
import { getMaxReturnValueWithoutAuth, getRefundMethodAfterWindow, getReturnWindowDays } from '../config/config.service.js';
import * as customers from '../customer/customer.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { assertAssignedLocation } from '../location/location.service.js';
import { creditReturn } from '../receivables/receivables.service.js';
import * as policy from './returns.policy.js';
import * as returns from './returns.repository.js';
import { refundableOnOrder, refundReturnedOrder, settleReturnedOrder } from '../payments/payments.service.js';
import type { Actor, Paging, RefundMethod, RefundPart, ReturnFilter, ReturnLineRequest, ReturnRecord, SaleForReturn, SaleLine } from './returns.types.js';

/**
 * Use cases of returns (A4): books brought back from a counter sale or a
 * delivered customer order. One function each, owning its transaction.
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
function valueLines(saleLines: SaleLine[], requested: ReturnLineRequest[], lineName: string): ValuedLine[] {
  const byId = new Map(saleLines.map((l) => [l.id, { ...l }]));
  return requested.map((r) => {
    const line = byId.get(String(r.lineId));
    if (!line) throw new NotFoundError(`${lineName} ${r.lineId}`);
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
 * The books go back to stock at the cost they left at, not today's average
 * (the return posting rule), 0 when they left with none (#163); damaged ones
 * are kept apart.
 */
async function restock(
  q: Queryable,
  actor: Actor,
  lines: ValuedLine[],
  from: { locationId: number; referenceType: string; referenceId: string },
): Promise<void> {
  for (const l of lines) {
    const change = {
      bookId: l.line.bookId,
      locationId: from.locationId,
      quantity: l.quantity,
      referenceType: from.referenceType,
      referenceId: from.referenceId,
      staffCtx: actor,
    };
    if (l.disposition === 'DAMAGED') {
      // Kept apart at the cost the books left at (#168).
      await inventoryService.receiveDamaged(q, {
        ...change, reasonCode: 'damage', notes: `Damaged return – ${l.quantity} unit(s)`, unitCost: l.line.unitCost ?? 0,
      });
    } else {
      await inventoryService.receiveStock(q, {
        ...change, reasonCode: 'return', notes: `Return of ${l.quantity} unit(s)`, unitCost: l.line.unitCost ?? 0, costMayBeZero: true,
      });
    }
  }
}

/** The return and its lines, numbered from the shared RET series. */
async function recordReturn(
  q: Queryable,
  actor: Actor,
  r: {
    sale: { transactionId: string | null; orderId: string | null; number: string; branchId: number; customerId: number | null };
    lines: ValuedLine[];
    total: Money;
    refundMethod: RefundMethod | 'mixed';
    reason: string | null;
    approved: boolean;
  },
): Promise<{ returnId: string; returnNumber: string }> {
  const returnNumber = await nextDailyNumber(q, 'RET');
  const returnId = await returns.insertReturn(q, {
    returnNumber,
    transactionId: r.sale.transactionId,
    orderId: r.sale.orderId,
    branchId: r.sale.branchId,
    customerId: r.sale.customerId,
    total: r.total,
    refundMethod: r.refundMethod,
    reason: r.reason,
    processedBy: actor.staffId,
    // Above the limit, the Manager or Admin who processed it approved it.
    approvedBy: r.approved ? actor.staffId : null,
  });
  for (const l of r.lines) {
    const byOrder = r.sale.orderId !== null;
    await returns.insertLine(q, returnId, {
      transactionLineItemId: byOrder ? null : l.line.id,
      orderLineItemId: byOrder ? l.line.id : null,
      bookId: l.line.bookId,
      quantity: l.quantity,
      unitPrice: l.line.unitPrice,
      value: l.value,
    });
  }
  return { returnId, returnNumber };
}

async function announce(
  q: Queryable,
  actor: Actor,
  r: { returnId: string; returnNumber: string; sale: Record<string, unknown>; saleNumber: string; total: Money; refundMethod: string; parts: RefundPart[] },
): Promise<void> {
  await insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action: 'CREATE',
    entityType: 'return',
    entityId: r.returnId,
    meta: {
      returnNumber: r.returnNumber,
      ...r.sale,
      totalRefundAmount: r.total.toNumber(),
      refundMethod: r.refundMethod,
      refunds: r.parts.map((p) => ({ method: p.method, amount: p.amount.toNumber() })),
    },
  });
  await insertOutboxEvent(q, 'return.initiated', {
    returnId: r.returnId, returnNumber: r.returnNumber, txNumber: r.saleNumber, branchId: actor.branchId, amount: r.total.toNumber(),
  });
}

/**
 * A return against a counter sale or a delivered customer order (#166, owner
 * decision 1a), in its own branch. Above the approval limit only a Manager
 * or Admin can process it (3a).
 */
export async function createReturn(
  actor: Actor,
  input: { transactionId?: number; orderId?: number; reason: string | null; lines: ReturnLineRequest[] },
): Promise<ReturnRecord> {
  const id = await withTransaction({}, (tx) =>
    input.orderId !== undefined
      ? returnOrder(tx, actor, { ...input, orderId: input.orderId })
      : returnSale(tx, actor, { ...input, transactionId: input.transactionId as number }),
  );
  return getById(id);
}

/**
 * The sale is locked, so returns on it run one after another and never take
 * back more than was sold. The books' value is first set against what the
 * customer still owes on the sale, as a credit note (1a); the rest goes back
 * the way the sale was paid (2a).
 */
async function returnSale(
  tx: Queryable,
  actor: Actor,
  input: { transactionId: number; reason: string | null; lines: ReturnLineRequest[] },
): Promise<string> {
  const sale = await returns.lockSale(tx, input.transactionId);
  if (!sale) throw new NotFoundError('Transaction');
  policy.checkSale(sale, actor.branchId);
  await assertAssignedLocation(sale.locationId, actor);

  const lines = valueLines(await returns.saleLines(tx, sale.id), input.lines, 'Transaction line item');
  const total = Money.sum(lines.map((l) => l.value));
  const maxWithoutAuth = Money.of(await getMaxReturnValueWithoutAuth());
  policy.checkApproval(total, maxWithoutAuth, actor.roles);

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

  await restock(tx, actor, lines, { locationId: sale.locationId, referenceType: 'pos_return', referenceId: sale.id });
  const { returnId, returnNumber } = await recordReturn(tx, actor, {
    sale: { transactionId: sale.id, orderId: null, number: sale.transactionNumber, branchId: sale.branchId, customerId: sale.customerId },
    lines,
    total,
    refundMethod,
    reason: input.reason,
    approved: total.greaterThan(maxWithoutAuth),
  });
  // A bank refund goes out of the account the sale was paid into (#21).
  const bankAccountId = parts.some((p) => p.method === 'bank') ? await returns.lastBankAccount(tx, sale.id) : null;
  for (const p of parts) {
    const account = p.method === 'bank' ? bankAccountId : null;
    const refundId = await returns.insertRefund(tx, returnId, p, account);
    if (account !== null) {
      await recordMovement(tx, { bankAccountId: account, direction: 'out', amount: p.amount, sourceType: 'return_refund', sourceId: refundId, notes: `Return ${returnNumber}` });
    }
  }

  await payBack(tx, sale, returnId, refunded);
  // What all returns on the sale took back, this one included.
  await reversePoints(tx, sale, Money.sum((await returns.saleLines(tx, sale.id)).map((l) => l.returnedValue)));

  await announce(tx, actor, {
    returnId, returnNumber, sale: { transactionId: sale.id }, saleNumber: sale.transactionNumber, total, refundMethod, parts,
  });
  return returnId;
}

/**
 * A delivered customer order, by the same rules (#166): only once delivered
 * (2a), the window counted from delivery (3a). A credit order's debt takes
 * the value first, as a credit note; the rest goes back through the order's
 * own payments, newest first, so Payments and the reports count each refund
 * once. Orders earn no points, so none are taken back. The order stays
 * completed; its lines show what came back (4a).
 */
async function returnOrder(
  tx: Queryable,
  actor: Actor,
  input: { orderId: number; reason: string | null; lines: ReturnLineRequest[] },
): Promise<string> {
  const order = await returns.lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError('Order');
  policy.checkOrder(order, actor.branchId);
  const locationId = order.locationId ?? (await returns.branchLocation(tx, order.branchId));
  if (locationId === null) throw new NotFoundError('Location');
  await assertAssignedLocation(locationId, actor);

  const lines = valueLines(await returns.orderLines(tx, order.id), input.lines, 'Order line item');
  const total = Money.sum(lines.map((l) => l.value));
  const maxWithoutAuth = Money.of(await getMaxReturnValueWithoutAuth());
  policy.checkApproval(total, maxWithoutAuth, actor.roles);

  const credited = order.saleType === 'credit_sale'
    ? await creditReturn(tx, { sourceType: 'order_credit_sale', sourceEntityId: order.id, amount: total })
    : Money.ZERO;
  const toRefund = total.minus(credited);
  const storeCreditOnly = policy.storeCreditOnly(
    order.daysSinceDelivery ?? 0,
    await getReturnWindowDays(order.branchId),
    await getRefundMethodAfterWindow(),
  );
  // The same refusals as a counter sale's, before anything is written.
  policy.allocateRefund(toRefund, [], {
    storeCreditOnly, hasCustomer: order.customerId !== null, paidLeft: await refundableOnOrder(tx, order.id),
  });

  await restock(tx, actor, lines, { locationId, referenceType: 'order_return', referenceId: order.id });
  // The refund method is known once the payments have been refunded; the
  // return is recorded first so each refund can name it.
  const { returnId, returnNumber } = await recordReturn(tx, actor, {
    sale: { transactionId: null, orderId: order.id, number: order.orderNumber, branchId: order.branchId, customerId: order.customerId },
    lines,
    total,
    refundMethod: 'cash',
    reason: input.reason,
    approved: total.greaterThan(maxWithoutAuth),
  });
  if (credited.greaterThan(0)) await returns.insertRefund(tx, returnId, { method: 'credit_note', amount: credited });
  const refunded: RefundPart[] = toRefund.greaterThan(0)
    ? (await refundReturnedOrder(tx, actor, order.id, {
        amount: toRefund, returnId, returnNumber, to: storeCreditOnly ? 'store_credit' : 'original',
      })).map((p) => ({ method: p.method as RefundMethod, amount: p.amount }))
    : [];
  await settleReturnedOrder(tx, order.id);
  const parts: RefundPart[] = credited.greaterThan(0) ? [{ method: 'credit_note', amount: credited }, ...refunded] : refunded;
  const refundMethod = policy.refundMethodOf(parts);
  await returns.setRefundMethod(tx, returnId, refundMethod);

  await announce(tx, actor, {
    returnId, returnNumber, sale: { orderId: order.id }, saleNumber: order.orderNumber, total, refundMethod, parts,
  });
  return returnId;
}
