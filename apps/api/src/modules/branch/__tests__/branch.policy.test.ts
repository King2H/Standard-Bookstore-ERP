import { describe, it, expect } from 'vitest';
import { checkCanEditDetails, checkCanOpenOrClose, checkDeletable } from '../branch.policy.js';
import type { Actor } from '../branch.types.js';

const staff = (role: string, allBranches = false): Actor => ({ staffId: 1, role, branchId: 10, allBranches });

describe('checkCanOpenOrClose', () => {
  it('allows Super_Admin, and Admin with access to all branches', () => {
    expect(() => checkCanOpenOrClose(staff('Super_Admin'))).not.toThrow();
    expect(() => checkCanOpenOrClose(staff('Admin', true))).not.toThrow();
  });

  it('refuses an Admin of one branch, and Managers', () => {
    for (const actor of [staff('Admin'), staff('Manager'), staff('Manager', true)]) {
      expect(() => checkCanOpenOrClose(actor)).toThrow(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
    }
  });
});

describe('checkCanEditDetails', () => {
  it('allows the session branch, and any branch for Super_Admin or with access to all branches', () => {
    expect(() => checkCanEditDetails(staff('Manager'), 10)).not.toThrow();
    expect(() => checkCanEditDetails(staff('Manager', true), 20)).not.toThrow();
    expect(() => checkCanEditDetails(staff('Super_Admin'), 20)).not.toThrow();
  });

  it('refuses another branch', () => {
    expect(() => checkCanEditDetails(staff('Admin'), 20)).toThrow(
      expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 }),
    );
  });
});

describe('checkDeletable', () => {
  it('allows a branch nothing belongs to, and lists what blocks the others', () => {
    expect(() => checkDeletable([])).not.toThrow();
    expect(() => checkDeletable([{ type: 'locations', count: 2 }])).toThrow(
      expect.objectContaining({ code: 'DEPENDENCY_CONFLICT', details: { blockingDependencies: [{ type: 'locations', count: 2 }] } }),
    );
  });
});
