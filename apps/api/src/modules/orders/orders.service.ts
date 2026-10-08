import type { PoolClient } from 'pg';
import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { BusinessError, NotFoundError } from '../../lib/errors.js';
import { insertOutbox, type OutboxEventType } from '../../lib/outbox.js';
import { getMaxLineDiscountPct, isNegativeStockAllowed } from '../config/config.service.js';
import { createReceivable, updateReceivableOnPayment } from '../receivables/receivables.service.js';
import * as invTxSvc from '../inventory/inventoryTransaction.service.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './orders.policy.js';
import * as orders from './orders.repository.js';
import type { OrderLineInput, OrderRow, PricedLine, SaleType, StaffCtx } from './orders.types.js';

export type { OrderLineInput, OrderLineItemRow, OrderRow, StaffCtx } from './orders.types.js';
export { computeOrderAllowedActions } from './orders.policy.js';

/**
 * Use cases of the Orders module (A4). Each change runs in one Unit of Work
 * (withTransaction): the Orders repository uses `tx`, and the Inventory and
 * Receivables services, still v1 until M5, run on `client`, the same
 * connection and transaction. A confirm therefore takes the stock out,
 * records the payment or opens the receivable, and moves the order on as one
 * step, or not at all.
 */

function audit(q: Queryable, staff: StaffCtx, action: string, orderId: string, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: staff.staffId,
    staffRole: staff.role,
    branchId: staff.branchId,
    action,
    entityType: 'order',
    entityId: orderId,
    meta,
  });
}

function publish(client: PoolClient, event: OutboxEventType, order: OrderRow, staff: StaffCtx, extra: Record<string, unknown> = {}) {
  return insertOutbox(client, event, { orderId: order.id, orderNumber: order.orderNumber, branchId: staff.branchId, ...extra });
}

/** The order with its line items; `allowedActions` is filled in by the routes. */
async function loadOrder(q: Queryable, id: string | number, opts: { forUpdate?: boolean } = {}): Promise<OrderRow> {
  const order = await orders.findById(q, id, opts);
  if (!order) throw new NotFoundError('Order');
  order.lineItems = await orders.listLineItems(q, order.id);
  order.allowedActions = [];
  return order;
}

/** Where an order's stock moves: its own location, else the branch's. */
async function stockLocation(q: Queryable, order: OrderRow, staff: StaffCtx): Promise<number> {
  return order.locationId ?? (await orders.findBranchLocation(q, order.branchId)) ?? staff.branchId;
}

export function getById(id: string | number): Promise<OrderRow> {
  return loadOrder(kysely, id);
}

export async function list(opts: {
  branchId?: number; customerId?: number; status?: string; paymentStatus?: string;
  channel?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number;
}): Promise<{ items: OrderRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  // A comma-separated status list (dashboard drill-downs) or a single status.
  const statuses = opts.status?.split(',').map((s) => s.trim()).filter(Boolean);
  const { items, total } = await orders.list(
    kysely,
    { ...opts, statuses },
    { limit: pageSize, offset: (page - 1) * pageSize },
  );
  return {
    items: items.map((o) => ({ ...o, allowedActions: [] as string[] })),
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function create(
  data: {
    customerId?: number | null;
    locationId?: number | null;
    channel?: string;
    notes?: string;
    saleType?: SaleType;
    items: OrderLineInput[];
  },
  staffCtx: StaffCtx,
): Promise<OrderRow> {
  const saleType = data.saleType ?? 'cash_sale';
  policy.checkNewOrder({ ...data, saleType });

  if (!(await orders.isBranchActive(kysely, staffCtx.branchId))) {
    throw new BusinessError('BRANCH_INACTIVE', 'This branch is inactive and cannot accept new orders');
  }
  if (data.customerId && !(await orders.isCustomerActive(kysely, data.customerId))) {
    throw new BusinessError('CUSTOMER_INACTIVE', 'This customer account is inactive');
  }

  const maxDiscountPct = await getMaxLineDiscountPct(staffCtx.branchId, staffCtx.role);
  const lines: PricedLine[] = [];
  for (const item of data.items) {
    policy.checkQuantity(item);
    const book = await orders.findBook(kysely, item.bookId);
    if (!book) throw new NotFoundError('Book ' + item.bookId);
    if (!book.isActive) throw new BusinessError('BOOK_INACTIVE', 'Book ' + item.bookId + ' is not active');
    const unitPrice = await orders.findSellingPrice(kysely, item.bookId, staffCtx.branchId);
    if (unitPrice === null) throw new BusinessError('PRICE_NOT_SET', 'Price not set for book ' + item.bookId);
    lines.push(policy.priceLine(item, unitPrice, maxDiscountPct));
  }
  const totals = policy.orderTotals(lines);

  // A draft neither reserves nor deducts stock; this early check only keeps
  // an order from being created oversold. confirm() re-checks under a row
  // lock (see #70).
  if (!(await isNegativeStockAllowed())) {
    const locationId = data.locationId || (await orders.findBranchLocation(kysely, staffCtx.branchId)) || staffCtx.branchId;
    for (const line of lines) {
      const stock = await invTxSvc.getAvailableStock(line.bookId, locationId);
      if (stock.available < line.quantity) {
        const title = (await orders.findBook(kysely, line.bookId))?.title ?? `Book ${line.bookId}`;
        throw new BusinessError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for "${title}". Available: ${stock.available}, Requested: ${line.quantity}`,
        );
      }
    }
  }

  const orderId = await withTransaction({}, async (tx, client) => {
    const { count, dateStr } = await orders.countCreatedToday(tx, 'orders');
    const orderNumber = policy.dailyNumber('ORD', dateStr, count);
    const id = await orders.insertOrder(tx, {
      orderNumber,
      customerId: data.customerId ?? null,
      branchId: staffCtx.branchId,
      locationId: data.locationId ?? null,
      channel: data.channel ?? 'in_store',
      saleType,
      notes: data.notes ?? null,
      createdBy: staffCtx.staffId,
      totals,
    });
    for (const line of lines) await orders.insertLineItem(tx, id, line);

    const total = Number(totals.total);
    await audit(tx, staffCtx, 'CREATE', id, { orderNumber, total, saleType, itemCount: lines.length });
    await insertOutbox(client, 'order.created', {
      orderId: id, orderNumber, branchId: staffCtx.branchId, total, saleType, channel: data.channel ?? 'in_store',
    });
    return id;
  });
  return getById(orderId);
}

/**
 * DRAFT -> CONFIRMED. Takes the stock out (and reserves it for fulfilment),
 * then either records the cash payment (a cash order is paid now) or opens
 * the receivable (a credit order is paid later).
 */
export async function confirm(
  orderId: string | number,
  staffCtx: StaffCtx,
  dueDate?: string | null,
  paymentMethod?: string | null,
): Promise<OrderRow> {
  await withTransaction({}, async (tx, client) => {
    // Locked, so two confirms of the same order cannot both take the stock out.
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    policy.checkCanConfirm(order.status);
    policy.checkDueDate(order, dueDate, await orders.today(tx));
    const method = policy.confirmPaymentMethod(order, paymentMethod);

    const locationId = await stockLocation(tx, order, staffCtx);
    for (const item of order.lineItems ?? []) {
      await orders.lockStock(tx, item.bookId, locationId);
      const stock = await invTxSvc.getAvailableStock(item.bookId, locationId, client);
      if (!(await isNegativeStockAllowed()) && stock.available < item.quantity) {
        const title = (await orders.findBook(tx, item.bookId))?.title ?? `Book ${item.bookId}`;
        const place = (await orders.findLocationName(tx, locationId)) ?? `Location ${locationId}`;
        throw new BusinessError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for "${title}" at ${place}. Available: ${stock.available}, Requested: ${item.quantity}`,
        );
      }
      await orders.setLineReserved(tx, item.id, item.quantity);
      await orders.insertReservation(tx, { orderId: order.id, bookId: item.bookId, locationId, quantity: item.quantity });
      // Stock leaves once, here; fulfil only records it. The line keeps the
      // average cost it left at, so its cost of goods never changes later.
      const { unitCost } = await invTxSvc.stockOut(
        {
          bookId: item.bookId,
          locationId,
          quantity: item.quantity,
          referenceType: 'order_confirmed',
          referenceId: orderId,
          reasonCode: 'correction',
          notes: `Order confirmation – order ${String(orderId)}`,
          staffCtx,
        },
        client,
      );
      await orders.setLineUnitCost(tx, item.id, Money.of(unitCost).toFixed(2));
    }

    if (method !== null) {
      await orders.setPaymentStatus(tx, order.id, 'paid');
      const amount = Money.of(order.total).toFixed(2);
      if (method === 'store_credit') {
        const customerId = order.customerId as number;
        policy.checkStoreCredit(await orders.lockStoreCreditBalance(tx, customerId), order.total);
        await orders.debitStoreCredit(tx, customerId, amount, String(orderId));
      }
      const { count, dateStr } = await orders.countCreatedToday(tx, 'order_payments');
      await orders.insertPayment(tx, {
        reference: policy.dailyNumber('PAY', dateStr, count),
        orderId: order.id,
        amount,
        method,
        notes: 'Recorded at order confirmation',
        processedBy: staffCtx.staffId,
      });
    }

    await orders.setStatus(tx, order.id, 'CONFIRMED');
    await audit(tx, staffCtx, 'UPDATE', String(orderId), { action: 'confirm', fromStatus: 'DRAFT', toStatus: 'CONFIRMED' });
    await publish(client, 'order.confirmed', { ...order, id: String(orderId) }, staffCtx);

    if (order.saleType === 'credit_sale' && order.customerId) {
      const outstanding = policy.amountToInvoice(order.total, await orders.sumPaid(tx, order.id));
      if (outstanding && !(await orders.hasReceivable(tx, order.id))) {
        await createReceivable(
          {
            sourceType: 'order_credit_sale',
            sourceRefId: order.orderNumber,
            sourceEntityId: Number(orderId),
            customerId: order.customerId,
            branchId: order.branchId,
            originalAmount: outstanding.toNumber(),
            dueDate: dueDate ?? null,
          },
          client,
        );
      }
    }
  });
  return getById(orderId);
}

/** Legacy CONFIRMED -> PAID (#69). */
export async function pay(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  await withTransaction({}, async (tx, client) => {
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    policy.checkCanPay(order.status);
    await orders.setStatus(tx, order.id, 'PAID');
    await audit(tx, staffCtx, 'UPDATE', String(orderId), { action: 'pay', fromStatus: 'CONFIRMED', toStatus: 'PAID' });
    await publish(client, 'order.paid', { ...order, id: String(orderId) }, staffCtx);
  });
  return getById(orderId);
}

/** Legacy Confirmed -> In_Progress (#69). */
export async function progress(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  await withTransaction({}, async (tx, client) => {
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    policy.checkCanProgress(order.status);
    await orders.setStatus(tx, order.id, 'In_Progress');
    await audit(tx, staffCtx, 'UPDATE', String(orderId), { action: 'progress' });
    await publish(client, 'order.in_progress', { ...order, id: String(orderId) }, staffCtx);
  });
  return getById(orderId);
}

/**
 * Hands the goods over: the reserved stock (already taken out at confirm) is
 * recorded as delivered, and the order is FULFILLED, then COMPLETED. A
 * credit order's receivable stays open until it is paid.
 */
export async function fulfill(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  await withTransaction({ isolationLevel: 'repeatable read' }, async (tx, client) => {
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    policy.checkCanFulfill(order.status);

    const locationId = await stockLocation(tx, order, staffCtx);
    const reserved = (order.lineItems ?? []).filter((item) => item.qtyReserved > 0);
    if (reserved.length > 0) {
      await invTxSvc.fulfillReservation(
        {
          orderId,
          locationId,
          lineItems: reserved.map((item) => ({ bookId: item.bookId, qtyReserved: item.qtyReserved })),
          staffCtx,
        },
        client,
      );
    }
    for (const item of reserved) await orders.fulfillLine(tx, item.id, item.qtyReserved);

    const ref = { ...order, id: String(orderId) };
    await orders.setStatus(tx, order.id, 'FULFILLED');
    await audit(tx, staffCtx, 'UPDATE', String(orderId), {
      action: 'fulfill', fromStatus: order.status, toStatus: 'FULFILLED', saleType: order.saleType,
    });
    await publish(client, 'order.fulfilled', ref, staffCtx);
    await orders.setStatus(tx, order.id, 'COMPLETED');
    await publish(client, 'order.completed', ref, staffCtx);
  });
  return getById(orderId);
}

/**
 * Cancels an unfulfilled order: stock taken out at confirm goes back at the
 * cost it left at, reservations are released and an open receivable is
 * settled. The order's finances are frozen from then on.
 */
export async function cancel(orderId: string | number, reason: string, staffCtx: StaffCtx): Promise<OrderRow> {
  await withTransaction({}, async (tx, client) => {
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    const { restoresStock } = policy.checkCanCancel(order.status);

    if (restoresStock) {
      const locationId = await stockLocation(tx, order, staffCtx);
      for (const item of order.lineItems ?? []) {
        if (item.qtyReserved <= 0) continue;
        await invTxSvc.stockIn(
          {
            bookId: item.bookId,
            locationId,
            quantity: item.qtyReserved,
            referenceType: 'order_cancelled',
            referenceId: orderId,
            reasonCode: 'return',
            notes: `Order cancellation – order ${String(orderId)}`,
            staffCtx,
            unitCost: item.unitCost != null && item.unitCost > 0 ? item.unitCost : undefined,
          },
          client,
        );
      }
      await orders.releaseReservations(tx, order.id);
    }
    for (const item of order.lineItems ?? []) {
      if (item.qtyReserved > 0) await orders.setLineReserved(tx, item.id, 0);
    }

    // Before the status changes: updateReceivableOnPayment() ignores
    // receivables of orders that are already CANCELLED.
    if (await orders.hasReceivable(tx, order.id, { openOnly: true })) {
      await updateReceivableOnPayment(
        { sourceType: 'order_credit_sale', sourceEntityId: Number(orderId), newOutstandingAmount: 0, isFullySettled: true },
        client,
      );
    }

    await orders.setStatus(tx, order.id, 'CANCELLED', reason);
    await audit(tx, staffCtx, 'UPDATE', String(orderId), {
      action: 'cancel', fromStatus: order.status, toStatus: 'CANCELLED', reason, financialLifecycleFrozen: true,
      note: 'Payment collection disabled. Receivable voided. No further financial transactions allowed.',
    });
    await publish(client, 'order.cancelled', { ...order, id: String(orderId) }, staffCtx, { reason });
  });
  return getById(orderId);
}

export async function updatePaymentStatus(orderId: string | number, paymentStatus: 'unpaid' | 'partial' | 'paid' | 'refunded'): Promise<void> {
  await orders.setPaymentStatus(kysely, String(orderId), paymentStatus);
}

/** Deletes a DRAFT or CANCELLED order that has no financial or inventory history. */
export async function deleteOrder(orderId: string | number, staffCtx: StaffCtx): Promise<void> {
  await withTransaction({}, async (tx) => {
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    policy.checkCanDelete(order, await orders.deleteBlockers(tx, order.id));
    await orders.deleteOrder(tx, order.id);
    await audit(tx, staffCtx, 'DELETE', String(orderId), { orderNumber: order.orderNumber, status: order.status });
  });
}

/** A (partial or full) payment against a fulfilled credit order's receivable. */
export async function collectPayment(
  orderId: string | number,
  paymentAmount: number,
  staffCtx: StaffCtx,
): Promise<OrderRow> {
  policy.checkPaymentAmount(paymentAmount);
  await withTransaction({}, async (tx, client) => {
    const order = await loadOrder(tx, orderId, { forUpdate: true });
    policy.checkCanCollectPayment(order);

    const outstanding = await orders.lockReceivableOutstanding(tx, order.id);
    if (outstanding === undefined) {
      throw new BusinessError('RECEIVABLE_NOT_FOUND', `No receivable found for order ${String(orderId)}`);
    }
    const { newOutstanding, isFullySettled } = policy.applyPayment(outstanding, paymentAmount);
    await updateReceivableOnPayment(
      { sourceType: 'order_credit_sale', sourceEntityId: Number(orderId), newOutstandingAmount: newOutstanding.toNumber(), isFullySettled },
      client,
    );
    await orders.setPaymentStatus(tx, order.id, isFullySettled ? 'paid' : 'partially_paid');
    await audit(tx, staffCtx, 'UPDATE', String(orderId), {
      action: 'collect_payment',
      paymentAmount,
      previousOutstanding: Number(outstanding),
      newOutstanding: newOutstanding.toNumber(),
      isFullySettled,
    });
  });
  return getById(orderId);
}
