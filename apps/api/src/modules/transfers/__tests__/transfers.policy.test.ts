import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  checkCanDispatch,
  checkCanReceive,
  checkEditable,
  checkResolverBranch,
  checkWithinOutstanding,
  inTransitValue,
  outstanding,
  statusAfter,
} from '../transfers.policy.js';
import { ROLE_PERMISSIONS } from '../../../lib/permissions.js';

const sending = { staffId: 7, role: 'Manager', roles: ['Manager'], branchId: 1 };
const receiving = { ...sending, branchId: 2 };
const transfer = { fromBranchId: 1, toBranchId: 2 };
const line = (quantity: number, done: Partial<Record<'received' | 'lost' | 'damaged' | 'returned', number>> = {}) => ({
  quantity,
  unitCost: Money.of('6.25'),
  receivedQuantity: done.received ?? 0,
  lostQuantity: done.lost ?? 0,
  damagedQuantity: done.damaged ?? 0,
  returnedQuantity: done.returned ?? 0,
});

describe('status (decision 1a)', () => {
  it('is edited and dispatched as a draft, received while copies are on the way', () => {
    expect(() => checkEditable('draft')).not.toThrow();
    expect(() => checkCanDispatch('draft')).not.toThrow();
    for (const status of ['in_transit', 'partially_received', 'received', 'closed', 'cancelled'] as const) {
      expect(() => checkEditable(status)).toThrow(expect.objectContaining({ code: 'TRANSFER_INVALID_STATUS' }));
      expect(() => checkCanDispatch(status)).toThrow(expect.objectContaining({ code: 'TRANSFER_INVALID_STATUS' }));
    }
    expect(() => checkCanReceive('in_transit')).not.toThrow();
    expect(() => checkCanReceive('partially_received')).not.toThrow();
    for (const status of ['draft', 'received', 'closed', 'cancelled'] as const) {
      expect(() => checkCanReceive(status)).toThrow(expect.objectContaining({ code: 'TRANSFER_INVALID_STATUS' }));
    }
  });

  it('ends received when everything arrived, closed when some was resolved, and stays open while copies are out', () => {
    expect(statusAfter([line(2)])).toBe('in_transit');
    expect(statusAfter([line(2, { received: 1 }), line(1)])).toBe('partially_received');
    expect(statusAfter([line(2, { lost: 1 })])).toBe('partially_received');
    expect(statusAfter([line(2, { received: 2 }), line(1, { received: 1 })])).toBe('received');
    expect(statusAfter([line(2, { received: 1, returned: 1 })])).toBe('closed');
    expect(statusAfter([line(3, { lost: 1, damaged: 1, returned: 1 })])).toBe('closed');
  });
});

describe('quantities', () => {
  it('counts what is still on the way, and takes no more than that', () => {
    expect(outstanding(line(6, { received: 3, lost: 1, damaged: 1 }))).toBe(1);
    expect(() => checkWithinOutstanding(line(6, { received: 5 }), 1)).not.toThrow();
    expect(() => checkWithinOutstanding(line(6, { received: 5 }), 2)).toThrow(expect.objectContaining({ code: 'TRANSFER_OVER_OUTSTANDING' }));
  });

  it('values copies in transit at the cost they left at, exactly', () => {
    expect(inTransitValue([line(3, { received: 1 }), line(1)]).toFixed(2)).toBe('18.75');
    expect(inTransitValue([{ ...line(2), unitCost: null }]).toFixed(2)).toBe('0.00');
  });
});

describe('branches (decisions 2a, 4a)', () => {
  it('leaves lost and damaged to the receiving branch, returned to the sending branch', () => {
    expect(() => checkResolverBranch(transfer, receiving, 'lost')).not.toThrow();
    expect(() => checkResolverBranch(transfer, receiving, 'damaged')).not.toThrow();
    expect(() => checkResolverBranch(transfer, sending, 'returned')).not.toThrow();
    expect(() => checkResolverBranch(transfer, sending, 'lost')).toThrow(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
    expect(() => checkResolverBranch(transfer, receiving, 'returned')).toThrow(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
  });

  it('gives sending and receiving to Admin, Manager and Stock_Clerk, resolving to Admin and Manager', () => {
    const holders = (p: string) => Object.entries(ROLE_PERMISSIONS).filter(([, ps]) => (ps as string[]).includes(p)).map(([r]) => r).sort();
    expect(holders('SEND_TRANSFER')).toEqual(['Admin', 'Manager', 'Stock_Clerk']);
    expect(holders('RECEIVE_TRANSFER')).toEqual(['Admin', 'Manager', 'Stock_Clerk']);
    expect(holders('RESOLVE_TRANSFER')).toEqual(['Admin', 'Manager']);
  });
});
