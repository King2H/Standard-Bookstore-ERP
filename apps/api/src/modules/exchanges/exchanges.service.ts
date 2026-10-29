import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { AppError, BusinessError, NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { accountForPayment, movementNote, recordMovement } from '../bankAccount/bankAccount.service.js';
import { getMaxReturnValueWithoutAuth } from '../config/config.service.js';
import { recordCounterMoney } from '../cashSessions/cashSessions.service.js';
import * as customers from '../customer/customer.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { checkTender } from '../pos/pos.policy.js';
import { cancelReceivable, createReceivable } from '../receivables/receivables.service.js';
import * as saleServices from '../services/saleServices.service.js';
import * as policy from './exchanges.policy.js';
import * as exchanges from './exchanges.repository.js';
import type { Actor, ExchangeFilter, ExchangeRecord, NewExchange, Paging, PaymentLine } from './exchanges.types.js';

/**
 * Use cases of exchanges (A4): books brought in for books taken out, settled
 * at the counter in one step (owner decision 1a), and a same-day void. One
 * function each, owning its transaction.
 */

function found(e: ExchangeRecord | undefined): ExchangeRecord {
  if (e === undefined) throw new NotFoundError('Exchange');
  return e;
}

function audit(q: Queryable, actor: Actor, action: string, id: string, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'exchange',
    entityId: id,
    meta,
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<ExchangeRecord> {
  const e = found(await exchanges.findExchange(kysely, id));
  const [{ incoming, outgoing }, settlementEntries, services] = await Promise.all([
    exchanges.items(kysely, id),
    exchanges.settlementEntries(kysely, id),
    saleServices.linesByBookLine(kysely, { exchangeId: id }),
  ]);
  return { ...e, incomingItems: incoming, outgoingItems: outgoing.map((o) => ({ ...o, service: services.get(o.id) ?? null })), settlementEntries };
}

export function list(filter: ExchangeFilter, paging: Paging): Promise<{ items: ExchangeRecord[]; total: number }> {
  return exchanges.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Making an exchange ────────────────────────────────────────────────────────

async function priceOf(q: Queryable, bookId: number, branchId: number): Promise<Money | null> {
  const book = await exchanges.bookPrice(q, bookId, branchId);
  if (!book) throw new NotFoundError(`Book ${bookId}`);
  if (!book.isActive) throw new BusinessError('BOOK_INACTIVE', `Book ${bookId} is not active`);
  return book.price;
}

/** Store credit and loyalty points the customer pays with, each checked under lock. */
async function spendFromAccounts(q: Queryable, customerId: number | null, payments: PaymentLine[], ref: string): Promise<void> {
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
      await customers.moveStoreCredit(q, customerId, p.amount, { direction: 'debit', refType: 'exchange_payment', refId: ref });
    }
    if (p.method === 'loyalty_points') {
      const available = (await customers.lockPoints(q, customerId)) ?? 0;
      if (Money.of(available).lessThan(p.amount)) {
        throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Insufficient loyalty points balance', {
          available,
          requested: p.amount.toNumber(),
        });
      }
      await customers.addPoints(q, customerId, -p.amount.toNumber(), { reason: 'REDEMPTION', transactionRef: ref });
    }
  }
}

/**
 * An exchange at the counter: the books brought in are valued (at most their
 * selling price) and go to stock at that value, damaged ones kept apart; the
 * books taken out are priced from the catalog and leave stock at their
 * average cost, a binding on them at the branch's fee (#169 PR 4). The difference is settled now: the customer pays it, or
 * leaves the rest on credit; or the store gives it back as store credit or
 * cash. All in one transaction: an exchange that cannot record its debt does
 * not happen.
 */
export async function createExchange(actor: Actor, input: NewExchange): Promise<ExchangeRecord> {
  checkTender(
    input.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference, payerBank: p.payerBank, bankAccountId: p.bankAccountId })),
    input.customerId,
  );

  const id = await withTransaction({}, async (tx) => {
    if (input.customerId !== null && !(await exchanges.isCustomerActive(tx, input.customerId))) {
      throw new BusinessError('CUSTOMER_INACTIVE', 'This customer account is inactive');
    }

    const incoming = [];
    for (const i of input.incoming) {
      policy.checkTradeInValue(i.bookId, i.unitValue, await priceOf(tx, i.bookId, input.branchId), actor.roles);
      incoming.push(i);
    }
    const outgoing = [];
    for (const o of input.outgoing) {
      const price = await priceOf(tx, o.bookId, input.branchId);
      if (price === null) throw new BusinessError('PRICE_NOT_SET', `Price not set for book ${o.bookId}`);
      outgoing.push({ ...o, price });
    }

    // Exchanges carry no discount, on books or fees (owner decision 2a); a binding needs a customer.
    const services = await saleServices.priceServices(tx, input.outgoing, { branchId: input.branchId, customerId: input.customerId, maxDiscountPct: 0 });
    const fees = saleServices.serviceTotals(services).subtotal;

    const totalIncoming = Money.sum(incoming.map((i) => i.unitValue.times(i.quantity))).round(2);
    const totalOutgoing = Money.sum(outgoing.map((o) => o.price.times(o.quantity))).plus(fees).round(2);
    policy.checkApproval(totalIncoming, Money.of(await getMaxReturnValueWithoutAuth()), actor.roles);

    const net = totalOutgoing.minus(totalIncoming);
    const type = policy.settlementType(net);
    const paid = Money.sum(input.payments.map((p) => p.amount));
    policy.checkSettlement(
      { net, paid, allowCredit: input.allowCredit, customerId: input.customerId, dueDate: input.dueDate, refundMethod: input.refundMethod },
      await exchanges.today(tx),
    );

    const reference = await nextDailyNumber(tx, 'EXC');
    const id = await exchanges.insertExchange(tx, {
      reference,
      branchId: input.branchId,
      locationId: input.locationId,
      customerId: input.customerId,
      totalIncoming,
      totalOutgoing,
      net,
      settlementType: type,
      refundMethod: type === 'Store_Refunds' ? input.refundMethod : null,
      notes: input.notes,
      createdBy: actor.staffId,
    });

    for (const i of incoming) {
      const change = { bookId: i.bookId, locationId: input.locationId, quantity: i.quantity, referenceId: id, staffCtx: actor };
      if (i.condition === 'damaged') {
        // At no cost: the sales report counts its allowance as a loss when it
        // comes in, so a repair must not charge it again on resale (#168).
        await inventoryService.receiveDamaged(tx, { ...change, referenceType: 'exchange_damaged', notes: 'Customer exchange: damaged trade-in' });
      } else {
        // The value given for the book is its cost in stock.
        await inventoryService.receiveStock(tx, {
          ...change, referenceType: 'customer_exchange', reasonCode: 'return', notes: 'Customer exchange: trade-in', unitCost: i.unitValue,
        });
      }
      await exchanges.insertIncoming(tx, id, i);
    }
    for (const [n, o] of outgoing.entries()) {
      const { unitCost } = await inventoryService.issueStock(tx, {
        bookId: o.bookId, locationId: input.locationId, quantity: o.quantity, referenceType: 'exchange_out', referenceId: id,
        reasonCode: 'sale', staffCtx: actor,
      });
      const lineId = await exchanges.insertOutgoing(tx, id, { ...o, unitCost });
      const service = services[n];
      if (service && input.customerId !== null) {
        const serviceLineId = await saleServices.recordServiceLine(tx, { exchangeLineId: lineId }, service);
        await saleServices.openJob(tx, actor, { id: serviceLineId, turnaroundDays: service.turnaroundDays },
          { branchId: input.branchId, customerId: input.customerId, number: reference });
      }
    }

    await spendFromAccounts(tx, input.customerId, input.payments, reference);
    for (const p of input.payments) {
      // With bank accounts on, a bank payment names an active account of the branch (#21).
      const bankAccountId = p.method === 'bank' ? await accountForPayment(tx, p.bankAccountId, input.branchId) : null;
      const entryId = await exchanges.insertEntry(tx, {
        exchangeId: id, entryType: 'cash_payment', amount: p.amount, method: p.method, reference: p.reference, payerBank: p.payerBank, by: actor.staffId, bankAccountId,
      });
      await recordCounterMoney(tx, actor, { kind: 'exchange_payment', sourceId: String(entryId), method: p.method, direction: 'in', amount: p.amount });
      if (bankAccountId !== null) {
        await recordMovement(tx, { bankAccountId, direction: 'in', amount: p.amount, sourceType: 'exchange_payment', sourceId: entryId,
          notes: movementNote(`Exchange ${reference}`, { payerBank: p.payerBank, reference: p.reference }) });
      }
    }
    const credit = type === 'Customer_Pays' ? net.minus(paid) : Money.ZERO;
    if (credit.greaterThan(0) && input.customerId !== null) {
      await createReceivable(tx, {
        sourceType: 'exchange_difference',
        sourceRefId: reference,
        sourceEntityId: Number(id),
        customerId: input.customerId,
        branchId: input.branchId,
        originalAmount: credit.toFixed(2),
        dueDate: input.dueDate,
      });
    }
    if (type === 'Store_Refunds') {
      const refund = net.negate();
      if (input.refundMethod === 'store_credit' && input.customerId !== null) {
        await customers.moveStoreCredit(tx, input.customerId, refund, { direction: 'credit', refType: 'exchange_refund', refId: reference });
      } else {
        const entryId = await exchanges.insertEntry(tx, { exchangeId: id, entryType: 'cash_refund', amount: refund, method: 'cash', by: actor.staffId });
        await recordCounterMoney(tx, actor, { kind: 'exchange_refund', sourceId: String(entryId), method: 'cash', direction: 'out', amount: refund });
      }
    }

    await audit(tx, actor, 'CREATE', id, {
      exchangeReference: reference,
      totalIncoming: totalIncoming.toNumber(),
      totalOutgoing: totalOutgoing.toNumber(),
      serviceFees: fees.toNumber(),
      netBalance: net.toNumber(),
      settlementType: type,
      paid: paid.toNumber(),
      onCredit: credit.toNumber(),
      refundMethod: type === 'Store_Refunds' ? input.refundMethod : null,
    });
    await insertOutboxEvent(tx, 'exchange.completed', {
      exchangeId: id, exchangeRef: reference, settlementType: type, netBalance: net.toNumber(), branchId: input.branchId,
    });
    if (type === 'Store_Refunds' && input.refundMethod === 'store_credit') {
      await insertOutboxEvent(tx, 'exchange.store_refund_due', {
        exchangeId: id, exchangeRef: reference, amount: net.negate().toNumber(), branchId: input.branchId,
      });
    }
    return id;
  });
  return getById(id);
}

// ── Voiding an exchange ───────────────────────────────────────────────────────

/**
 * Undoes an exchange on the day it was made (owner decision 5a): the books go
 * back both ways, store credit and points the customer paid with go back to
 * the account, money paid otherwise is handed back (recorded in the audit
 * entry), store credit the exchange gave is taken back while unspent, and a
 * receivable is cancelled. Its binding jobs are cancelled while Requested;
 * once their work started, or a binding fee was given back, it stands (#169
 * PR 4). The exchange is locked, so two voids cannot both move its stock.
 */
export async function voidExchange(actor: Actor, id: string, reason: string): Promise<ExchangeRecord> {
  await withTransaction({}, async (tx) => {
    const e = found(await exchanges.findExchange(tx, id, { forUpdate: true }));
    policy.checkCanVoid(e);
    await saleServices.cancelJobs(tx, actor, { exchangeId: id }, e.exchangeReference);
    const locationId = e.locationId!;
    const { incoming, outgoing } = await exchanges.items(tx, id);
    const entries = await exchanges.settlementEntries(tx, id);

    if (e.settlementType === 'Store_Refunds' && e.refundMethod === 'store_credit' && e.customerId !== null) {
      const given = e.netBalance.negate();
      policy.checkStoreCreditUnspent((await customers.lockStoreCredit(tx, e.customerId)) ?? Money.ZERO, given);
      await customers.moveStoreCredit(tx, e.customerId, given, { direction: 'debit', refType: 'exchange_void', refId: e.exchangeReference });
    }
    await cancelReceivable(tx, { sourceType: 'exchange_difference', sourceEntityId: id, paymentsReturned: true });

    for (const i of incoming) {
      const change = { bookId: i.bookId, locationId, quantity: i.quantity, referenceId: id, staffCtx: actor, notes: 'Exchange voided' };
      if (i.condition === 'damaged') await inventoryService.issueDamaged(tx, { ...change, referenceType: 'exchange_damaged' });
      else await inventoryService.issueStock(tx, { ...change, referenceType: 'customer_exchange', reasonCode: 'correction' });
    }
    for (const o of outgoing) {
      await inventoryService.receiveStock(tx, {
        bookId: o.bookId,
        locationId,
        quantity: o.quantity,
        referenceType: 'exchange_out',
        referenceId: id,
        reasonCode: 'return',
        notes: 'Exchange voided',
        staffCtx: actor,
        // At the cost the copies left at; 0 when they left with none (#163).
        unitCost: o.unitCost ?? 0,
        costMayBeZero: true,
      });
    }

    const handedBack: Record<string, number> = {};
    for (const p of entries.filter((x) => x.entryType === 'cash_payment')) {
      if (e.customerId !== null && p.method === 'store_credit') {
        await customers.moveStoreCredit(tx, e.customerId, p.amount, { direction: 'credit', refType: 'exchange_void', refId: e.exchangeReference });
      } else if (e.customerId !== null && p.method === 'loyalty_points') {
        await customers.addPoints(tx, e.customerId, p.amount.toNumber(), { reason: 'VOID_REVERSAL', transactionRef: e.exchangeReference });
      } else {
        const method = p.method ?? 'cash';
        handedBack[method] = Money.of(handedBack[method] ?? 0).plus(p.amount).toNumber();
        // From the drawer that took it, while that session is open (#171).
        await recordCounterMoney(tx, actor, {
          kind: 'exchange_void', sourceId: String(p.id), method, direction: 'out', amount: p.amount, reverses: { kind: 'exchange_payment', sourceId: String(p.id) },
        });
        // A bank payment goes back from the account it came in to.
        if (method === 'bank' && p.bankAccountId !== null) {
          await recordMovement(tx, {
            bankAccountId: p.bankAccountId, direction: 'out', amount: p.amount, sourceType: 'exchange_void', sourceId: p.id, notes: `Void of ${e.exchangeReference}`,
          });
        }
      }
    }
    const cashRefund = entries.filter((x) => x.entryType === 'cash_refund');
    const takenBack = Money.sum(cashRefund.map((x) => x.amount));
    for (const x of cashRefund) {
      await recordCounterMoney(tx, actor, {
        kind: 'exchange_void', sourceId: String(x.id), method: 'cash', direction: 'in', amount: x.amount, reverses: { kind: 'exchange_refund', sourceId: String(x.id) },
      });
    }

    await exchanges.setVoided(tx, id, actor.staffId, reason);
    await audit(tx, actor, 'UPDATE', id, {
      action: 'void', exchangeReference: e.exchangeReference, reason, paymentsHandedBack: handedBack, cashRefundTakenBack: takenBack.toNumber(),
    });
    await insertOutboxEvent(tx, 'exchange.cancelled', { exchangeId: id, exchangeRef: e.exchangeReference, branchId: e.branchId });
  });
  return getById(id);
}

/**
 * The lifecycle flow (initiate, review, approve, settle, cancel) is retired
 * (owner decision 1a): an exchange is made in one step and undone by a void.
 */
export function lifecycleRetired(): never {
  throw new AppError(
    'DEPRECATED',
    'Exchanges are made in one step with POST /exchanges, and undone on their day with POST /exchanges/{id}/void.',
    410,
  );
}
