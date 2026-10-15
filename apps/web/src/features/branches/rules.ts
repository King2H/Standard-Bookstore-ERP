import type { ProfileResponse } from '@bms/shared';

/**
 * Who may do what with branches and their locations: the API's rules
 * (branch.policy.ts, branchParamInScope), so the screens offer only what the
 * API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles' | 'currentBranchId' | 'isAllBranches'>;

/** Opening, closing, creating and deleting branches: Super_Admin, or Admin with access to all branches. */
export function canManageBranches(me: Account | undefined): boolean {
  if (!me) return false;
  return me.currentRoles.includes('Super_Admin') || (me.currentRoles.includes('Admin') && me.isAllBranches);
}

/** Changing a branch's locations: Super_Admin, Admin or Manager, in the session branch unless with access to all branches. */
export function canChangeLocations(me: Account | undefined, branchId: number): boolean {
  if (!me) return false;
  const manages = me.currentRoles.some((r) => r === 'Super_Admin' || r === 'Admin' || r === 'Manager');
  return manages && (me.isAllBranches || me.currentBranchId === branchId);
}
