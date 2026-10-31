import { describe, it, expect } from 'vitest';
import { checkKeepsLinked, checkLinkable, placement } from '../specialOrders.policy.js';
import type { LockedLine } from '../specialOrders.types.js';

// #174: which special-order lines a purchase order takes, and how.

const line = (over: Partial<LockedLine> = {}): LockedLine => ({
  id: '7', orderId: '3', orderNumber: 'ORD-20261031-0003', orderStatus: 'CONFIRMED', branchId: 1, locationId: null,
  bookId: 9, bookTitle: 'Dune', specialOrder: true, onOrder: 3, linked: 1, ...over,
});

describe('special orders on a purchase order (#174)', () => {
  it('takes a confirmed order\'s special-order line, at most its copies on no purchase order yet', () => {
    expect(() => checkLinkable(line(), 2)).not.toThrow();
    expect(() => checkLinkable(line(), 3)).toThrow(expect.objectContaining({ code: 'SPECIAL_ORDER_EXCEEDS_REMAINING' }));
    expect(() => checkLinkable(line({ specialOrder: false }), 1)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => checkLinkable(line({ orderStatus: 'DRAFT' }), 1)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('grows or creates a draft\'s line, and takes a submitted order\'s spare copies only', () => {
    expect(placement('draft', { quantity: 2, receivedQuantity: 0 }, 2, 5, undefined)).toBe('grow');
    expect(placement('draft', undefined, 0, 1, '8')).toBe('create');
    expect(() => placement('draft', undefined, 0, 1, undefined)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(placement('ordered', { quantity: 5, receivedQuantity: 1 }, 2, 2, undefined)).toBe('room');
    expect(() => placement('ordered', { quantity: 5, receivedQuantity: 1 }, 2, 3, undefined)).toThrow(expect.objectContaining({ code: 'SPECIAL_ORDER_NO_ROOM' }));
    expect(() => placement('received', { quantity: 5, receivedQuantity: 5 }, 0, 1, undefined)).toThrow(expect.objectContaining({ code: 'PO_INVALID_STATUS' }));
  });

  it('keeps on a draft\'s edit, per book, the copies its special orders wait for', () => {
    const linked = new Map([[9, 4]]);
    expect(() => checkKeepsLinked(linked, [{ bookId: 9, quantity: 3 }, { bookId: 9, quantity: 1 }])).not.toThrow();
    expect(() => checkKeepsLinked(linked, [{ bookId: 9, quantity: 3 }])).toThrow(expect.objectContaining({ code: 'SPECIAL_ORDERS_LINKED' }));
  });
});
