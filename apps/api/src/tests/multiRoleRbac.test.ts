/**
 * Regression tests for multi-role RBAC permission aggregation.
 *
 * These tests verify that getPermissionsForRoles() correctly unions permissions
 * from all assigned roles, so a staff member with multiple roles gets the full
 * set of permissions regardless of role ordering.
 */
import { describe, it, expect } from 'vitest';
import { getPermissionsForRoles, ROLE_PERMISSIONS } from '../lib/permissions.js';

describe('getPermissionsForRoles — multi-role aggregation', () => {
  it('returns empty array for empty roles list', () => {
    expect(getPermissionsForRoles([])).toEqual([]);
  });

  it('returns correct permissions for a single role', () => {
    const perms = getPermissionsForRoles(['Stock_Clerk']);
    expect(perms).toContain('MANAGE_INVENTORY');
    expect(perms).not.toContain('CREATE_SALE');
    expect(perms).not.toContain('PROCESS_PAYMENT');
  });

  it('Finance_Officer + Stock_Clerk gets union of both roles permissions', () => {
    const perms = getPermissionsForRoles(['Finance_Officer', 'Stock_Clerk']);
    // From Finance_Officer
    expect(perms).toContain('PROCESS_PAYMENT');
    expect(perms).toContain('PROCESS_REFUND');
    expect(perms).toContain('VIEW_REPORTS');
    // From Stock_Clerk
    expect(perms).toContain('MANAGE_INVENTORY');
    // Not from either
    expect(perms).not.toContain('CREATE_SALE');
    expect(perms).not.toContain('MANAGE_STAFF');
  });

  it('Sales + Purchasor gets union of both roles permissions', () => {
    const perms = getPermissionsForRoles(['Sales', 'Purchasor']);
    // From Sales
    expect(perms).toContain('CREATE_SALE');
    expect(perms).toContain('PROCESS_PAYMENT');
    // From Purchasor
    expect(perms).toContain('MANAGE_INVENTORY');
    expect(perms).toContain('VIEW_REPORTS');
    // Not from either
    expect(perms).not.toContain('PROCESS_REFUND');
    expect(perms).not.toContain('MANAGE_STAFF');
  });

  it('role order does not matter — same permissions regardless of order', () => {
    const perms1 = getPermissionsForRoles(['Finance_Officer', 'Stock_Clerk']);
    const perms2 = getPermissionsForRoles(['Stock_Clerk', 'Finance_Officer']);
    expect(new Set(perms1)).toEqual(new Set(perms2));
  });

  it('deduplicates permissions that appear in multiple roles', () => {
    // Both Admin and Manager have MANAGE_INVENTORY — should appear only once
    const perms = getPermissionsForRoles(['Admin', 'Manager']);
    const manageInventoryCount = perms.filter(p => p === 'MANAGE_INVENTORY').length;
    expect(manageInventoryCount).toBe(1);
  });

  it('Admin gets all permissions', () => {
    const perms = getPermissionsForRoles(['Admin']);
    const adminPerms = ROLE_PERMISSIONS['Admin'];
    for (const p of adminPerms) {
      expect(perms).toContain(p);
    }
  });

  it('three roles — Finance_Officer + Stock_Clerk + Sales — gets full union', () => {
    const perms = getPermissionsForRoles(['Finance_Officer', 'Stock_Clerk', 'Sales']);
    expect(perms).toContain('PROCESS_PAYMENT');
    expect(perms).toContain('PROCESS_REFUND');
    expect(perms).toContain('VIEW_REPORTS');
    expect(perms).toContain('MANAGE_INVENTORY');
    expect(perms).toContain('CREATE_SALE');
  });

  it('unknown role returns empty permissions without throwing', () => {
    const perms = getPermissionsForRoles(['NonExistentRole']);
    expect(perms).toEqual([]);
  });

  it('mix of known and unknown roles returns only known role permissions', () => {
    const perms = getPermissionsForRoles(['Stock_Clerk', 'NonExistentRole']);
    expect(perms).toContain('MANAGE_INVENTORY');
    expect(perms).toHaveLength(1);
  });
});
