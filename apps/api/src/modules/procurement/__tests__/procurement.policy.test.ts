import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  approvalKindFor,
  checkCanCancel,
  checkCanClose,
  checkOrderingBranch,
  checkReceiptLine,
  checkReceivingBranch,
  financialStatus,
  orderTotal,
  statusAfterReceipt,
  statusAfterSubmit,
  stockByLocation,
} from '../procurement.policy.js';
import { ROLE_PERMISSIONS } from '../../../lib/permissions.js';

const actor = { staffId: 7, role: 'Manager', roles: ['Manager'], branchId: 1 };

describe('branches', () => {
  it('leaves buying to the ordering branch and receiving to the receiving branch', () => {
    expect(() => checkOrderingBranch({ branchId: 1 }, actor)).not.toThrow();
    expect(() => checkOrderingBranch({ branchId: 2 }, actor)).toThrow(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
    expect(() => checkReceivingBranch({ receivingBranchId: 1 }, actor)).not.toThrow();
    expect(() => checkReceivingBranch({ receivingBranchId: 2 }, actor)).toThrow(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
  });
});

describe('value', () => {
  it('totals the lines exactly, free copies included', () => {
    const total = orderTotal([
      { quantity: 3, unitCost: Money.of('1.15') },
      { quantity: 2, unitCost: Money.ZERO },
    ]);
    expect(total.toFixed()).toBe('3.45');
  });

  it('owes only what was received', () => {
    expect(financialStatus(Money.ZERO, Money.of(50))).toBe('unpaid');
    expect(financialStatus(Money.of(100), Money.ZERO)).toBe('unpaid');
    expect(financialStatus(Money.of(100), Money.of(40))).toBe('partial');
    expect(financialStatus(Money.of(100), Money.of('99.99'))).toBe('paid');
  });
});

describe('status', () => {
  it('approves a draft on submit below the threshold', () => {
    expect(statusAfterSubmit('draft', Money.of(1000), Money.of(1000))).toBe('approved');
    expect(statusAfterSubmit('draft', Money.of(1001), Money.of(1000))).toBe('pending_approval');
    expect(() => statusAfterSubmit('approved', Money.of(1), Money.of(1000))).toThrow(expect.objectContaining({ code: 'PO_INVALID_STATUS' }));
  });

  it('gives APPROVE_PURCHASE_ORDER to Admin and Manager only (owner decision 3a, 2026-10-23)', () => {
    const holders = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.includes('APPROVE_PURCHASE_ORDER')).map(([role]) => role);
    expect(holders.sort()).toEqual(['Admin', 'Manager']);
  });

  it('records who approved: its creator or another approver, with no reason asked (owner decisions 1a, 2a, 2026-10-23)', () => {
    const pending = { status: 'pending_approval' as const };
    expect(approvalKindFor({ ...pending, createdBy: 7 }, actor)).toBe('creator');
    expect(approvalKindFor({ ...pending, createdBy: 8 }, actor)).toBe('approver');
    expect(() => approvalKindFor({ status: 'approved', createdBy: 8 }, actor)).toThrow(expect.objectContaining({ code: 'PO_INVALID_STATUS' }));
  });

  it('cancels until anything arrives', () => {
    expect(() => checkCanCancel('ordered', false)).not.toThrow();
    expect(() => checkCanCancel('ordered', true)).toThrow(expect.objectContaining({ code: 'CANNOT_CANCEL_WITH_RECEIPTS' }));
    expect(() => checkCanCancel('partially_received', true)).toThrow(expect.objectContaining({ code: 'PO_INVALID_STATUS' }));
  });

  it('closes a received order, or a part-received one with a reason', () => {
    expect(() => checkCanClose('received', null)).not.toThrow();
    expect(() => checkCanClose('partially_received', 'Out of print')).not.toThrow();
    expect(() => checkCanClose('partially_received', null)).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => checkCanClose('ordered', 'x')).toThrow(expect.objectContaining({ code: 'PO_INVALID_STATUS' }));
  });

  it('receives only what is still expected, on the order\'s own lines', () => {
    const line = { poId: '5', quantity: 10, receivedQuantity: 8 };
    expect(() => checkReceiptLine(line, '5', 1, 2)).not.toThrow();
    expect(() => checkReceiptLine(line, '5', 1, 3)).toThrow(expect.objectContaining({ code: 'OVER_RECEIPT' }));
    expect(() => checkReceiptLine(line, '6', 1, 1)).toThrow(expect.objectContaining({ code: 'LINE_ITEM_MISMATCH' }));
    expect(statusAfterReceipt([{ quantity: 2, receivedQuantity: 2 }, { quantity: 1, receivedQuantity: 0 }])).toBe('partially_received');
    expect(statusAfterReceipt([{ quantity: 2, receivedQuantity: 2 }])).toBe('received');
  });
});

describe('stock by location for the buyer (owner correction, 2026-10-23)', () => {
  it('merges on hand and on order by location, drops empty locations, and puts a location not chosen yet last', () => {
    expect(stockByLocation(
      [
        { locationId: 2, locationName: 'Store', quantity: 4 },
        { locationId: 1, locationName: 'Shop', quantity: 50 },
        { locationId: 3, locationName: 'Back Room', quantity: 0 },
        { locationId: 4, locationName: 'Annex', quantity: -2 },
      ],
      [
        { locationId: null, locationName: null, quantity: 8 },
        { locationId: 1, locationName: 'Shop', quantity: 15 },
        { locationId: 5, locationName: 'Window', quantity: 0 },
      ],
    )).toEqual([
      { locationId: 4, locationName: 'Annex', onHand: -2, onOrder: 0 },
      { locationId: 1, locationName: 'Shop', onHand: 50, onOrder: 15 },
      { locationId: 2, locationName: 'Store', onHand: 4, onOrder: 0 },
      { locationId: null, locationName: null, onHand: 0, onOrder: 8 },
    ]);
  });
});
