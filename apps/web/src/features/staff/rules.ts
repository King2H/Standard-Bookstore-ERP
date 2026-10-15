import { grantableRoles, rankOf, type ProfileResponse } from '@bms/shared';

/**
 * Who may do what on the Staff page: the API's rules (staff.routes.ts,
 * staff.policy.ts, location.policy.ts), so the page offers only what the API
 * accepts. The API also says, per account, whether the signed-in staff member
 * may change it (`canManage`). Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles' | 'currentBranchId' | 'isAllBranches'>;

const roles = (me: Account | undefined) => me?.currentRoles ?? [];

/** The roles the signed-in staff member may grant: those below their own; a Super_Admin grants any. */
export const rolesToGrant = (me: Account | undefined) => grantableRoles(roles(me));

/** Creating accounts, resetting passwords, unlocking, deactivating: Admin and Super_Admin. */
export const canAdministerAccounts = (me: Account | undefined) => rankOf(roles(me)) >= 2;

/** Access to all branches is granted and removed by a Super_Admin only. */
export const canSetAllBranches = (me: Account | undefined) => roles(me).includes('Super_Admin');

/** A staff member's locations in a branch: changed from that branch, unless with access to all branches. */
export function canChangeLocationsIn(me: Account | undefined, branchId: number): boolean {
  if (!me) return false;
  return me.isAllBranches || me.currentBranchId === branchId;
}

/**
 * The branches whose roles the signed-in staff member may change ('all', or a
 * list): every branch for a Super_Admin or an Admin with access to all
 * branches, an Admin's own Admin branches, a Manager's session branch.
 */
export function roleBranches(me: (Account & Pick<ProfileResponse, 'roles'>) | undefined): 'all' | number[] {
  const held = roles(me);
  if (!me) return [];
  if (held.includes('Super_Admin')) return 'all';
  if (held.includes('Admin')) {
    return me.isAllBranches ? 'all' : [...new Set(me.roles.filter((r) => r.role === 'Admin').map((r) => r.branchId))];
  }
  if (held.includes('Manager')) return [me.currentBranchId];
  return [];
}

export const inBranches = (branches: 'all' | number[], branchId: number) => branches === 'all' || branches.includes(branchId);
