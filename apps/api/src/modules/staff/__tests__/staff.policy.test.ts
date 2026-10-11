import { describe, it, expect } from 'vitest';
import { grantableRoles, rankOf } from '@bms/shared';
import { canManage, canView, checkRoleChanges, keepsASuperAdmin, reach, roleChanges, visibility } from '../staff.policy.js';
import type { Actor } from '../staff.types.js';

const actor = (roles: string[], over: Partial<Actor> = {}): Actor => ({
  staffId: 1,
  role: roles[0],
  roles,
  branchId: 10,
  isAllBranches: false,
  assignments: roles.map((role) => ({ branchId: 10, role })),
  ...over,
});
const sales = (branchId: number) => [{ branchId, role: 'Sales' }];

describe('ranks', () => {
  it('orders Super_Admin, Admin, Manager, then the rest', () => {
    expect(rankOf(['Sales', 'Manager'])).toBe(1);
    expect(rankOf([])).toBe(-1);
  });

  it('grants only roles below your own, except Super_Admin who grants any', () => {
    expect(grantableRoles(['Manager'])).toEqual(['Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor']);
    expect(grantableRoles(['Admin'])).toEqual(['Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor']);
    expect(grantableRoles(['Super_Admin'])).toContain('Super_Admin');
    expect(grantableRoles(['Sales'])).toEqual([]);
  });
});

describe('reach and visibility', () => {
  it('gives a Super_Admin and an all-branch Admin every branch', () => {
    expect(reach(actor(['Super_Admin']))).toBe('all');
    expect(reach(actor(['Admin'], { isAllBranches: true }))).toBe('all');
  });

  it("gives another Admin their Admin branches, a Manager the session branch", () => {
    const admin = actor(['Admin'], { assignments: [{ branchId: 10, role: 'Admin' }, { branchId: 20, role: 'Admin' }, { branchId: 30, role: 'Sales' }] });
    expect(reach(admin)).toEqual([10, 20]);
    expect(reach(actor(['Manager'], { branchId: 30 }))).toEqual([30]);
  });

  it('shows Admins the accounts without roles, not Managers', () => {
    expect(visibility(actor(['Admin']))).toEqual({ all: false, branchIds: [10], includeRoleless: true });
    expect(canView(actor(['Manager']), 2, [])).toBe(false);
    expect(canView(actor(['Admin']), 2, [])).toBe(true);
    expect(canView(actor(['Manager']), 2, sales(20))).toBe(false);
  });
});

describe('canManage', () => {
  it('never yourself', () => {
    expect(canManage(actor(['Super_Admin']), 1, [])).toBe(false);
  });

  it('only people ranked below, except Super_Admins with each other', () => {
    expect(canManage(actor(['Admin']), 2, [{ branchId: 10, role: 'Admin' }])).toBe(false);
    expect(canManage(actor(['Manager']), 2, [{ branchId: 10, role: 'Manager' }])).toBe(false);
    expect(canManage(actor(['Super_Admin']), 2, [{ branchId: 10, role: 'Super_Admin' }])).toBe(true);
  });

  it('an Admin only staff whose roles are all in their branches; a Manager staff with a role in theirs', () => {
    const both = [...sales(10), ...sales(20)];
    expect(canManage(actor(['Admin']), 2, both)).toBe(false);
    expect(canManage(actor(['Admin']), 2, sales(10))).toBe(true);
    expect(canManage(actor(['Manager']), 2, both)).toBe(true);
  });
});

describe('role changes', () => {
  it('finds what is added and removed', () => {
    const { added, removed } = roleChanges(
      [{ branchId: 10, role: 'Sales' }, { branchId: 20, role: 'Sales' }],
      [{ branchId: 10, role: 'Stock_Clerk' }, { branchId: 20, role: 'Sales' }, { branchId: 20, role: 'Sales' }],
    );
    expect(added).toEqual([{ branchId: 10, role: 'Stock_Clerk' }]);
    expect(removed).toEqual([{ branchId: 10, role: 'Sales' }]);
  });

  it('refuses a change outside the branches managed, or of a role not grantable', () => {
    expect(() => checkRoleChanges(actor(['Manager']), sales(20))).toThrow(/branch 20/);
    expect(() => checkRoleChanges(actor(['Manager']), [{ branchId: 10, role: 'Manager' }])).toThrow(/Manager role/);
    expect(() => checkRoleChanges(actor(['Manager']), sales(10))).not.toThrow();
  });

  it('keeps a Super_Admin', () => {
    expect(keepsASuperAdmin(0)).toBe(false);
    expect(keepsASuperAdmin(1)).toBe(true);
  });
});
