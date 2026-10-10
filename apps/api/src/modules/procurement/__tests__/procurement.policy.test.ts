import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  checkCanApprove,
  checkCanCancel,
  checkCanClose,
  checkOrderingBranch,
  checkReceiptLine,
  checkReceivingBranch,
  financialStatus,
  orderTotal,
  statusAfterReceipt,
  statusAfterSubmit,
} from '../procurement.policy.js';

const actor = { staffId: 7, role: 'Manager', branchId: 1 };

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

  it('refuses self-approval', () => {
    expect(() => checkCanApprove({ status: 'pending_approval', createdBy: 7 }, actor)).toThrow(
      expect.objectContaining({ code: 'SELF_APPROVAL_NOT_ALLOWED' }),
    );
    expect(() => checkCanApprove({ status: 'pending_approval', createdBy: 8 }, actor)).not.toThrow();
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
