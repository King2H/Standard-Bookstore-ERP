import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { recordMovement } from '../bankAccount/bankAccount.service.js';
import { getMaxReturnValueWithoutAuth, getRefundMethodAfterWindow, getReturnWindowDays } from '../config/config.service.js';
import { recordCounterMoney } from '../cashSessions/cashSessions.service.js';
import * as customers from '../customer/customer.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { assertAssignedLocation } from '../location/location.service.js';
import { creditReturn } from '../receivables/receivables.service.js';
import * as saleServices from '../services/saleServices.service.js';
import * as policy from './returns.policy.js';
import * as returns from './returns.repository.js';
import { refundableOnOrder, refundReturnedOrder, settleReturnedOrder } from '../payments/payments.service.js';
import type { FeeReturn } from '../services/services.types.js';
import type {
  Actor, ExchangeForReturn, OrderForReturn, Paging, RefundMethod, RefundPart, ReturnFilter, ReturnLineRequest, ReturnRecord, SaleForReturn, SaleLine,
} from './returns.types.js';

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
  /** Bound copies brought back defective (#169 PR 3). */
  defective: boolean;
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
    return { line, quantity: r.quantity, disposition: r.disposition, defective: r.defective ?? false, value };
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
    sale: { transactionId: string | null; orderId: string | null; exchangeId?: string; number: string; branchId: number; customerId: number | null };
    lines: ValuedLine[];
    total: Money;
    refundMethod: RefundMethod | 'mixed';
    reason: string | null;
    approved: boolean;
    undelivered?: boolean;
  },
): Promise<{ returnId: string; returnNumber: string }> {
  const returnNumber = await nextDailyNumber(q, 'RET');
  const returnId = await returns.insertReturn(q, {
    returnNumber,
    transactionId: r.sale.transactionId,
    orderId: r.sale.orderId,
    exchangeId: r.sale.exchangeId ?? null,
    branchId: r.sale.branchId,
    customerId: r.sale.customerId,
    total: r.total,
    refundMethod: r.refundMethod,
    reason: r.reason,
    processedBy: actor.staffId,
    // Above the limit, the Manager or Admin who processed it approved it.
    approvedBy: r.approved ? actor.staffId : null,
    undelivered: r.undelivered,
  });
  for (const l of r.lines) {
    const byOrder = r.sale.orderId !== null;
    const byExchange = r.sale.exchangeId !== undefined;
    await returns.insertLine(q, returnId, {
      transactionLineItemId: byOrder || byExchange ? null : l.line.id,
      orderLineItemId: byOrder ? l.line.id : null,
      exchangeLineItemId: byExchange ? l.line.id : null,
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
  input: { transactionId?: number; orderId?: number; exchangeId?: number; reason: string | null; lines: ReturnLineRequest[] },
): Promise<ReturnRecord> {
  const id = await withTransaction({}, (tx) =>
    input.orderId !== undefined ? returnOrder(tx, actor, { ...input, orderId: input.orderId })
      : input.exchangeId !== undefined ? returnExchange(tx, actor, { ...input, exchangeId: input.exchangeId })
      : returnSale(tx, actor, { ...input, transactionId: input.transactionId as number }),
  );
  return getById(id);
}

/**
 * Bound copies on the lines a return names (#169 PR 3): plain copies come
 * back as any book; a bound one only defective, once handed over, with a
 * reason and a Manager or Admin, kept apart as damaged, taking its share of
 * the fee with it (4a). Returns the fees given back.
 */
async function boundCopies(
  tx: Queryable,
  actor: Actor,
  lines: ValuedLine[],
  sale: 'pos' | 'order' | 'exchange',
  reason: string | null,
): Promise<FeeReturn[]> {
  const ids = lines.map((l) => l.line.id);
  const bindings = await saleServices.bindingsOf(tx,
    sale === 'order' ? { orderLineIds: ids } : sale === 'exchange' ? { exchangeLineIds: ids } : { posLineIds: ids });
  // What came back before this return, line by line; valueLines already counted this one in.
  const requested = new Map<string, number>();
  for (const l of lines) requested.set(l.line.id, (requested.get(l.line.id) ?? 0) + l.quantity);
  const soFar = new Map<string, number>();
  const fees: FeeReturn[] = [];
  for (const l of lines) {
    const found = bindings.get(l.line.id);
    // A cancelled binding left ordinary copies.
    const binding = found && found.jobStatus !== 'CANCELLED' ? found : undefined;
    const before = soFar.get(l.line.id) ?? l.line.returnedQuantity - (requested.get(l.line.id) ?? 0);
    soFar.set(l.line.id, before + l.quantity);
    if (!binding) continue;
    const left = saleServices.copiesLeft({ quantity: l.line.quantity, returnedQuantity: before }, binding);
    saleServices.checkBoundReturn(`line ${l.line.id}`, { quantity: l.quantity, defective: l.defective }, left, binding.jobStatus);
    if (!l.defective) continue;
    if (!actor.roles.includes('Manager') && !actor.roles.includes('Admin')) {
      throw new BusinessError('APPROVAL_REQUIRED', 'A bound copy comes back defective only with a Manager or Admin');
    }
    if (!reason?.trim()) throw new ValidationError('Say what is wrong with the bound copy', { field: 'reason' });
    l.disposition = 'DAMAGED';
    const amount = saleServices.feeShare(binding, l.quantity);
    // The binding's cost stays a loss: the work was done (4a).
    fees.push({ binding: { ...binding }, quantity: l.quantity, amount, costReversed: Money.ZERO, kind: 'DEFECT' });
    binding.returnedQuantity += l.quantity;
    binding.returnedAmount = binding.returnedAmount.plus(amount);
  }
  return fees;
}

/**
 * A return's money on a counter sale: what it takes back is first set
 * against what the customer still owes on the sale, as a credit note (1a);
 * the rest goes back the way the sale was paid (2a). The books go back to
 * stock and the fees given back are recorded on the return.
 */
async function settleSale(
  tx: Queryable,
  actor: Actor,
  sale: SaleForReturn,
  r: { lines: ValuedLine[]; fees: FeeReturn[]; reason: string | null; approved: boolean },
): Promise<string> {
  const total = Money.sum([...r.lines.map((l) => l.value), ...r.fees.map((f) => f.amount)]);
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

  await restock(tx, actor, r.lines, { locationId: sale.locationId, referenceType: 'pos_return', referenceId: sale.id });
  const { returnId, returnNumber } = await recordReturn(tx, actor, {
    sale: { transactionId: sale.id, orderId: null, number: sale.transactionNumber, branchId: sale.branchId, customerId: sale.customerId },
    lines: r.lines,
    total,
    refundMethod,
    reason: r.reason,
    approved: r.approved,
  });
  for (const fee of r.fees) await saleServices.recordFeeReturn(tx, actor, returnId, fee, sale.transactionNumber);
  // A bank refund goes out of the account the sale was paid into (#21).
  const bankAccountId = parts.some((p) => p.method === 'bank') ? await returns.lastBankAccount(tx, sale.id) : null;
  for (const p of parts) {
    const account = p.method === 'bank' ? bankAccountId : null;
    const refundId = await returns.insertRefund(tx, returnId, p, account);
    await recordCounterMoney(tx, actor, { kind: 'return_refund', sourceId: refundId, method: p.method, direction: 'out', amount: p.amount });
    if (account !== null) {
      await recordMovement(tx, { bankAccountId: account, direction: 'out', amount: p.amount, sourceType: 'return_refund', sourceId: refundId, notes: `Return ${returnNumber}` });
    }
  }

  await payBack(tx, sale, returnId, refunded);
  // What all returns on the sale took back, this one included: books and fees.
  const books = Money.sum((await returns.saleLines(tx, sale.id)).map((l) => l.returnedValue));
  await reversePoints(tx, sale, books.plus(await saleServices.feesReturnedOnSale(tx, sale.id)));

  await announce(tx, actor, {
    returnId, returnNumber, sale: { transactionId: sale.id }, saleNumber: sale.transactionNumber, total, refundMethod, parts,
  });
  return returnId;
}

/**
 * A return's money on a customer order, by the same rules (#166): a credit
 * order's debt takes the value first, as a credit note; the rest goes back
 * through the order's own payments, newest first, so Payments and the
 * reports count each refund once. Orders earn no points.
 */
async function settleOrder(
  tx: Queryable,
  actor: Actor,
  order: OrderForReturn,
  r: { locationId: number | null; lines: ValuedLine[]; fees: FeeReturn[]; reason: string | null; approved: boolean; undelivered?: Undelivered },
): Promise<string> {
  const total = Money.sum([...r.lines.map((l) => l.value), ...r.fees.map((f) => f.amount)]);
  const credited = order.saleType === 'credit_sale'
    ? await creditReturn(tx, { sourceType: 'order_credit_sale', sourceEntityId: order.id, amount: total })
    : Money.ZERO;
  const toRefund = total.minus(credited);
  // Undelivered copies know no return window: the money goes back as chosen (#174).
  const storeCreditOnly = r.undelivered
    ? r.undelivered.refundTo === 'store_credit'
    : policy.storeCreditOnly(order.daysSinceDelivery ?? 0, await getReturnWindowDays(order.branchId), await getRefundMethodAfterWindow());
  r.undelivered?.authorize(toRefund);
  // The same refusals as a counter sale's, before anything is written.
  policy.allocateRefund(toRefund, [], {
    storeCreditOnly, hasCustomer: order.customerId !== null, paidLeft: await refundableOnOrder(tx, order.id),
  });

  if (r.locationId !== null) {
    await restock(tx, actor, r.lines, {
      locationId: r.locationId, referenceType: r.undelivered ? 'order_cancelled' : 'order_return', referenceId: order.id,
    });
  }
  // The refund method is known once the payments have been refunded; the
  // return is recorded first so each refund can name it.
  const { returnId, returnNumber } = await recordReturn(tx, actor, {
    sale: { transactionId: null, orderId: order.id, number: order.orderNumber, branchId: order.branchId, customerId: order.customerId },
    lines: r.lines,
    total,
    refundMethod: 'cash',
    reason: r.reason,
    approved: r.approved,
    undelivered: r.undelivered !== undefined,
  });
  for (const fee of r.fees) await saleServices.recordFeeReturn(tx, actor, returnId, fee, order.orderNumber);
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

/**
 * A return's money on an exchange (#169 PR 4, 5a; #203, 2a): what it takes
 * back goes first against what the exchange left on credit, as a credit note;
 * the rest to the customer's store credit (a binding always has a customer).
 * An exchange settles its difference at once, so there is no tender to give
 * back. A defective copy is kept apart as damaged at the cost it left at.
 */
async function settleExchange(
  tx: Queryable,
  actor: Actor,
  exchange: ExchangeForReturn,
  r: { lines: ValuedLine[]; fees: FeeReturn[]; reason: string },
): Promise<string> {
  if (exchange.voided) throw new BusinessError('ALREADY_VOIDED', 'Exchange is already voided');
  const total = Money.sum([...r.lines.map((l) => l.value), ...r.fees.map((f) => f.amount)]);
  const credited = await creditReturn(tx, { sourceType: 'exchange_difference', sourceEntityId: exchange.id, amount: total });
  const rest = total.minus(credited);
  const parts: RefundPart[] = [
    ...(credited.greaterThan(0) ? [{ method: 'credit_note' as const, amount: credited }] : []),
    ...(rest.greaterThan(0) ? [{ method: 'store_credit' as const, amount: rest }] : []),
  ];
  const refundMethod = policy.refundMethodOf(parts);
  const { returnId, returnNumber } = await recordReturn(tx, actor, {
    sale: { transactionId: null, orderId: null, exchangeId: exchange.id, number: exchange.reference, branchId: exchange.branchId, customerId: exchange.customerId },
    lines: r.lines,
    total,
    refundMethod,
    reason: r.reason,
    approved: true,
  });
  if (r.lines.length > 0) {
    if (exchange.locationId === null) throw new NotFoundError('Location');
    await restock(tx, actor, r.lines, { locationId: exchange.locationId, referenceType: 'return', referenceId: returnId });
  }
  for (const fee of r.fees) await saleServices.recordFeeReturn(tx, actor, returnId, fee, exchange.reference);
  for (const p of parts) await returns.insertRefund(tx, returnId, p, null);
  if (rest.greaterThan(0) && exchange.customerId !== null) {
    await customers.moveStoreCredit(tx, exchange.customerId, rest, { direction: 'credit', refType: 'return', refId: returnId });
  }
  await announce(tx, actor, {
    returnId, returnNumber, sale: { exchangeId: exchange.id }, saleNumber: exchange.reference, total, refundMethod, parts,
  });
  return returnId;
}

/**
 * A defective bound copy an exchange gave out (#203, owner decision 1a):
 * only bound copies come back this way, by the rules of a sale's (#169 PR 3,
 * 4a); a plain copy is swapped in a new exchange. The exchange is locked, so
 * its void and its returns run one after the other.
 */
async function returnExchange(
  tx: Queryable,
  actor: Actor,
  input: { exchangeId: number; reason: string | null; lines: ReturnLineRequest[] },
): Promise<string> {
  const exchange = await returns.lockExchange(tx, String(input.exchangeId));
  if (!exchange || exchange.branchId !== actor.branchId) throw new NotFoundError('Exchange');
  if (exchange.locationId !== null) await assertAssignedLocation(exchange.locationId, actor);
  const lines = valueLines(await returns.exchangeLines(tx, exchange.id), input.lines, 'Exchange line item');
  const bindings = await saleServices.bindingsOf(tx, { exchangeLineIds: lines.map((l) => l.line.id) });
  for (const l of lines) {
    const binding = bindings.get(l.line.id);
    if (!l.defective || !binding || binding.jobStatus === 'CANCELLED') {
      throw new BusinessError('EXCHANGE_COPY_RETURN', 'A book from an exchange is swapped in a new exchange; only a defective bound copy comes back here');
    }
  }
  const fees = await boundCopies(tx, actor, lines, 'exchange', input.reason);
  return settleExchange(tx, actor, exchange, { lines, fees, reason: input.reason as string });
}

/**
 * The sale is locked, so returns on it run one after another and never take
 * back more than was sold.
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
  const fees = await boundCopies(tx, actor, lines, 'pos', input.reason);
  const total = Money.sum([...lines.map((l) => l.value), ...fees.map((f) => f.amount)]);
  const maxWithoutAuth = Money.of(await getMaxReturnValueWithoutAuth());
  policy.checkApproval(total, maxWithoutAuth, actor.roles);
  return settleSale(tx, actor, sale, { lines, fees, reason: input.reason, approved: total.greaterThan(maxWithoutAuth) || fees.length > 0 });
}

/**
 * A delivered customer order, by the same rules (#166): only once delivered
 * (2a), the window counted from delivery (3a). The order stays completed;
 * its lines show what came back (4a).
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

  const lines = valueLines(await returns.orderLines(tx, order.id, { partDelivered: order.status === 'PART_DELIVERED' }), input.lines, 'Order line item');
  const fees = await boundCopies(tx, actor, lines, 'order', input.reason);
  const total = Money.sum([...lines.map((l) => l.value), ...fees.map((f) => f.amount)]);
  const maxWithoutAuth = Money.of(await getMaxReturnValueWithoutAuth());
  policy.checkApproval(total, maxWithoutAuth, actor.roles);
  return settleOrder(tx, actor, order, { locationId, lines, fees, reason: input.reason, approved: total.greaterThan(maxWithoutAuth) || fees.length > 0 });
}

/** How the money for undelivered copies goes back, and who may send it (#174). */
interface Undelivered {
  refundTo: 'original' | 'store_credit' | undefined;
  /** Refuses the staff member when `toRefund` would go back without the right to refund. */
  authorize: (toRefund: Money) => void;
}

/**
 * The copies a part-delivered order will never deliver (#174, decisions
 * 1a–2a), within the order's own transaction, the order locked by the
 * caller: a return of them, marked as never delivered, at their share of
 * their lines. They go back to stock at the cost they left at; a credit
 * order's debt takes the value first and the rest goes back the way it was
 * paid or as store credit. No return window or approval limit: nothing came
 * back over the counter.
 */
export async function returnUndelivered(
  tx: Queryable,
  actor: Actor,
  input: {
    order: Omit<OrderForReturn, 'daysSinceDelivery'>;
    locationId: number;
    lines: Array<{ lineId: number; quantity: number }>;
    reason: string;
    undelivered: Undelivered;
  },
): Promise<{ returnId: string; returnNumber: string }> {
  const requested: ReturnLineRequest[] = input.lines.map((l) => ({ ...l, disposition: 'SELLABLE' }));
  const lines = valueLines(await returns.orderLines(tx, input.order.id), requested, 'Order line item');
  const returnId = await settleOrder(tx, actor, { ...input.order, daysSinceDelivery: null }, {
    locationId: input.locationId, lines, fees: [], reason: `Not delivered: ${input.reason}`, approved: true, undelivered: input.undelivered,
  });
  return { returnId, returnNumber: await returns.returnNumberOf(tx, returnId) };
}

// ── Cancelling a binding ──────────────────────────────────────────────────────

/**
 * A binding cancelled while its work has not started (#169 PR 3, owner
 * decision 3a), by a Manager or Admin with a reason: its fee goes back as a
 * return of the fee, the way the sale was paid, and its standard cost comes
 * off the sale's cost. The copies stay sold, ordinary ones from then on. An
 * order's fee goes back through its payments, delivered or not.
 */
export async function cancelBinding(actor: Actor, jobId: number, reason: string): Promise<void> {
  await withTransaction({}, async (tx) => {
    const { binding, sale } = await saleServices.jobForCancel(tx, jobId, actor.branchId);
    saleServices.checkCancellable(binding.jobStatus);
    const quantity = binding.quantity - binding.returnedQuantity;
    const fee: FeeReturn = {
      binding,
      quantity,
      amount: binding.lineTotal.minus(binding.returnedAmount),
      costReversed: binding.standardCost.times(quantity),
      kind: 'CANCELLED',
    };
    if ('transactionId' in sale) {
      const found = await returns.lockSale(tx, Number(sale.transactionId));
      if (!found) throw new NotFoundError('Transaction');
      policy.checkSale(found, actor.branchId);
      await settleSale(tx, actor, found, { lines: [], fees: [fee], reason, approved: true });
    } else if ('orderId' in sale) {
      const order = await returns.lockOrder(tx, Number(sale.orderId));
      if (!order) throw new NotFoundError('Order');
      if (order.branchId !== actor.branchId) throw new NotFoundError('Order');
      await settleOrder(tx, actor, order, { locationId: null, lines: [], fees: [fee], reason, approved: true });
    } else {
      const exchange = await returns.lockExchange(tx, sale.exchangeId);
      if (!exchange || exchange.branchId !== actor.branchId) throw new NotFoundError('Exchange');
      await settleExchange(tx, actor, exchange, { lines: [], fees: [fee], reason });
    }
  });
}
