import { describe, it, expect } from 'vitest';
import {
  checkCanManageStaff,
  checkDeletable,
  checkStaffLocationChange,
  hasFullLocationAccess,
  manageableBranches,
} from '../location.policy.js';
import type { Actor } from '../location.types.js';

const managerOfA: Actor = { staffId: 1, role: 'Manager', branchId: 10, allBranches: false };
const allBranches: Actor = { ...managerOfA, allBranches: true };

describe('who is limited to their assigned locations', () => {
  it('never limits the roles that manage locations', () => {
    for (const role of ['Super_Admin', 'Admin', 'Manager']) expect(hasFullLocationAccess(role)).toBe(true);
    for (const role of ['Sales', 'Stock_Clerk', 'Purchasor', 'Finance_Officer']) expect(hasFullLocationAccess(role)).toBe(false);
  });
});

describe('which staff and branches an actor manages', () => {
  it('is the session branch, or every branch with access to all branches', () => {
    expect(manageableBranches(managerOfA)).toEqual([10]);
    expect(manageableBranches(allBranches)).toBeNull();
  });

  it('refuses staff who do not work in the session branch', () => {
    expect(() => checkCanManageStaff(managerOfA, [10, 20])).not.toThrow();
    expect(() => checkCanManageStaff(managerOfA, [20])).toThrow(expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }));
    expect(() => checkCanManageStaff(allBranches, [20])).not.toThrow();
    expect(() => checkCanManageStaff(allBranches, [])).not.toThrow();
  });
});

describe('checkStaffLocationChange', () => {
  // Locations 1 and 2 are in branch 10, location 3 in branch 20.
  const branchOf = new Map([[1, 10], [2, 10], [3, 20]]);
  const currentInB = [{ locationId: 3, branchId: 20 }];

  it('lets the actor change their own branch while other branches are sent back unchanged', () => {
    expect(() => checkStaffLocationChange(managerOfA, [1, 3], branchOf, [10, 20], currentInB)).not.toThrow();
    expect(() => checkStaffLocationChange(managerOfA, [3], branchOf, [10, 20], currentInB)).not.toThrow();
  });

  it('refuses a change to another branch: adding or removing one of its locations', () => {
    expect(() => checkStaffLocationChange(managerOfA, [1], branchOf, [10, 20], currentInB)).toThrow(
      expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 }),
    );
    expect(() => checkStaffLocationChange(managerOfA, [1, 3], branchOf, [10, 20], [])).toThrow(
      expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED' }),
    );
  });

  it('lets staff with access to all branches change any branch', () => {
    expect(() => checkStaffLocationChange(allBranches, [1], branchOf, [10, 20], currentInB)).not.toThrow();
  });

  it('refuses locations that do not exist or are outside the staff member\'s branches', () => {
    expect(() => checkStaffLocationChange(allBranches, [99], branchOf, [10, 20], [])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => checkStaffLocationChange(allBranches, [3], branchOf, [10], [])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe('checkDeletable', () => {
  it('allows a location without stock or history', () => {
    expect(() => checkDeletable(0, [])).not.toThrow();
  });

  it('refuses one with stock or history, listing what blocks it', () => {
    expect(() => checkDeletable(2, [])).toThrow(
      expect.objectContaining({ code: 'DEPENDENCY_CONFLICT', details: { blockingDependencies: [{ type: 'inventory', count: 2 }] } }),
    );
    expect(() => checkDeletable(0, [{ type: 'orders', count: 1 }])).toThrow(
      expect.objectContaining({ code: 'DEPENDENCY_CONFLICT', details: { blockingDependencies: [{ type: 'orders', count: 1 }] } }),
    );
  });
});
