import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import type { Queryable } from '../../db/tx.js';
import { NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { findBranchLocation } from '../orders/orders.repository.js';
import { reserveForLine } from '../orders/orders.service.js';
import * as policy from './specialOrders.policy.js';
import * as links from './specialOrders.repository.js';
import type { Actor, OpenLineRecord, Paging } from './specialOrders.types.js';

/**
 * Special orders (#174, owner decisions 4a and 1a–6a): lines for books not
 * in stock, bought for the customer on a purchase order and reserved for
 * the order when they arrive.
 */

export async function list(branchId: number, opts: { toOrderOnly: boolean }, paging: Paging): Promise<{ items: OpenLineRecord[]; total: number }> {
  return links.openLines(kysely, branchId, { ...opts, limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

/**
 * Adds special-order lines of the session branch to a purchase order of it
 * (decision 3a); the caller holds the purchase order's lock and has checked
 * the actor may change it.
 */
export async function link(
  tx: Queryable,
  actor: Actor,
  po: { id: string; status: string },
  requested: Array<{ orderLineId: number; quantity: number; unitCost?: string | number }>,
): Promise<void> {
  const linked = await links.linkedByBook(tx, po.id);
  for (const r of requested) {
    const line = await links.lockLine(tx, r.orderLineId, actor.branchId);
    if (!line) throw new NotFoundError(`Order line ${r.orderLineId}`);
    policy.checkLinkable(line, r.quantity);
    const poLine = await links.poLineForBook(tx, po.id, line.bookId);
    const unitCost = r.unitCost === undefined ? undefined : String(r.unitCost);
    const how = policy.placement(po.status, poLine, linked.get(line.bookId) ?? 0, r.quantity, unitCost);
    if (how === 'grow') await links.growPoLine(tx, poLine!.id, r.quantity);
    if (how === 'create') await links.insertPoLine(tx, po.id, { bookId: line.bookId, quantity: r.quantity, unitCost: Money.of(unitCost!) });
    await links.addLink(tx, { orderLineId: line.id, poId: po.id, quantity: r.quantity, createdBy: actor.staffId });
    linked.set(line.bookId, (linked.get(line.bookId) ?? 0) + r.quantity);
  }
  await links.retotalPo(tx, po.id);
}

/** A draft purchase order's new lines keep the copies its special orders wait for. */
export async function checkEdit(tx: Queryable, poId: string, lines: Array<{ bookId: number; quantity: number }>): Promise<void> {
  policy.checkKeepsLinked(await links.linkedByBook(tx, poId), lines);
}

/** A purchase order cancelled or closed short brings nothing more: its lines go back to be bought. */
export function release(tx: Queryable, poId: string): Promise<void> {
  return links.releaseForPo(tx, poId);
}

/**
 * Copies of a book arriving on a purchase order (decision 4a): reserved for
 * its linked lines, oldest order first, where they arrive at the order's own
 * place; the sellers are told. Arriving elsewhere, they stay in stock and the
 * sellers are told to bring them over and reserve them. Returns the copies reserved.
 */
export async function arrive(
  tx: Queryable,
  actor: Actor,
  a: { poId: string; branchId: number; locationId: number; bookId: number; quantity: number },
): Promise<number> {
  let left = a.quantity;
  const open = await links.openLinks(tx, a.poId, a.bookId);
  const bookTitle = open.length > 0 ? await links.bookTitle(tx, a.bookId) : '';
  for (const l of open) {
    if (left === 0) break;
    const take = Math.min(left, l.outstanding);
    const orderLocation = l.locationId ?? (await findBranchLocation(tx, l.branchId)) ?? null;
    const event = { orderId: l.orderId, orderNumber: l.orderNumber, branchId: l.branchId, bookId: a.bookId, bookTitle, quantity: take };
    if (l.branchId !== a.branchId || orderLocation !== a.locationId) {
      await insertOutboxEvent(tx, 'special_order.arrived_elsewhere', { ...event, locationName: await links.locationName(tx, a.locationId) });
      continue;
    }
    await reserveForLine(tx, { ...actor, roles: actor.roles }, {
      orderId: l.orderId, lineId: l.orderLineId, bookId: a.bookId, locationId: a.locationId, quantity: take,
      note: `Special order arrived – order ${l.orderNumber}`,
    });
    await links.addReserved(tx, l.id, take);
    await insertAuditEntry(tx, {
      staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action: 'UPDATE', entityType: 'order', entityId: l.orderId,
      meta: { action: 'special_order_arrived', lineId: l.orderLineId, poId: a.poId, quantity: take },
    });
    await insertOutboxEvent(tx, 'special_order.arrived', event);
    left -= take;
  }
  return a.quantity - left;
}
