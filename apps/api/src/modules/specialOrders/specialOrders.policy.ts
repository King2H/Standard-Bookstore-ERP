import { BusinessError, ValidationError } from '../../lib/errors.js';
import type { LockedLine } from './specialOrders.types.js';

/**
 * Special-order rules (#174) as pure functions: which lines a purchase order
 * takes, and how much room it has for them.
 */

const OPEN = ['CONFIRMED', 'PAID', 'PART_DELIVERED', 'Confirmed', 'In_Progress'];

/** A confirmed order's special-order line, taking at most its copies on no purchase order yet. */
export function checkLinkable(line: LockedLine, quantity: number): void {
  if (!line.specialOrder || !OPEN.includes(line.orderStatus)) {
    throw new BusinessError('INVALID_STATE', `Line ${line.id} of ${line.orderNumber} is not a confirmed special order`);
  }
  const toOrder = Math.max(0, line.onOrder - line.linked);
  if (quantity > toOrder) {
    throw new BusinessError('SPECIAL_ORDER_EXCEEDS_REMAINING', `"${line.bookTitle}" for ${line.orderNumber}: ${toOrder} copies left to order, ${quantity} asked`, {
      lineId: line.id, toOrder, requested: quantity,
    });
  }
}

/**
 * How a purchase order takes the copies (decision 3a): a draft's line for the
 * book grows, or is created at a cost given; an order already submitted takes
 * them only where it has copies still to come that no line is waiting for.
 */
export function placement(
  status: string,
  poLine: { quantity: number; receivedQuantity: number } | undefined,
  alreadyLinked: number,
  quantity: number,
  unitCost: string | undefined,
): 'grow' | 'create' | 'room' {
  if (status === 'draft') {
    if (poLine) return 'grow';
    if (unitCost === undefined) throw new ValidationError('The purchase order has no line for this book: give its unit cost', { field: 'unitCost' });
    return 'create';
  }
  if (!['pending_approval', 'approved', 'ordered', 'partially_received'].includes(status)) {
    throw new BusinessError('PO_INVALID_STATUS', `A ${status} purchase order takes no special orders`);
  }
  const room = poLine ? poLine.quantity - poLine.receivedQuantity - alreadyLinked : 0;
  if (quantity > room) {
    throw new BusinessError('SPECIAL_ORDER_NO_ROOM', `The purchase order brings ${Math.max(0, room)} more copies no line waits for; only a draft grows`, {
      room: Math.max(0, room), requested: quantity,
    });
  }
  return 'room';
}

/** A draft's edit keeps, per book, at least the copies linked lines wait for. */
export function checkKeepsLinked(linked: Map<number, number>, lines: Array<{ bookId: number; quantity: number }>): void {
  for (const [bookId, need] of linked) {
    const has = lines.filter((l) => l.bookId === bookId).reduce((n, l) => n + l.quantity, 0);
    if (has < need) {
      throw new BusinessError('SPECIAL_ORDERS_LINKED', `Book ${bookId}: ${need} copies are for special orders; the order keeps at least those`, {
        bookId, linked: need, quantity: has,
      });
    }
  }
}
