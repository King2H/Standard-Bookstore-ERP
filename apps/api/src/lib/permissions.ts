export type Permission =
  | 'CREATE_SALE'
  | 'PROCESS_PAYMENT'
  | 'APPROVE_EXCHANGE'
  | 'PROCESS_REFUND'
  | 'ADJUST_PRICE'
  | 'MANAGE_INVENTORY'
  | 'VIEW_REPORTS'
  | 'MANAGE_STAFF'
  | 'MANAGE_BRANCH';

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  Super_Admin: [
    'CREATE_SALE',
    'PROCESS_PAYMENT',
    'APPROVE_EXCHANGE',
    'PROCESS_REFUND',
    'ADJUST_PRICE',
    'MANAGE_INVENTORY',
    'VIEW_REPORTS',
    'MANAGE_STAFF',
    'MANAGE_BRANCH',
  ],
  Admin: [
    'CREATE_SALE',
    'PROCESS_PAYMENT',
    'APPROVE_EXCHANGE',
    'PROCESS_REFUND',
    'ADJUST_PRICE',
    'MANAGE_INVENTORY',
    'VIEW_REPORTS',
    'MANAGE_STAFF',
    'MANAGE_BRANCH',
  ],
  Manager: [
    'CREATE_SALE',
    'PROCESS_PAYMENT',
    'APPROVE_EXCHANGE',
    'PROCESS_REFUND',
    'ADJUST_PRICE',
    'MANAGE_INVENTORY',
    'VIEW_REPORTS',
    'MANAGE_STAFF',
  ],
  Finance_Officer: ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS'],
  Stock_Clerk: ['MANAGE_INVENTORY'],
  Sales: ['CREATE_SALE', 'PROCESS_PAYMENT'],
  Purchasor: ['MANAGE_INVENTORY', 'VIEW_REPORTS'],
};

/**
 * Returns the union of all permissions for the given roles.
 * Duplicate permissions are deduplicated.
 */
export function getPermissionsForRoles(roles: string[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const perm of ROLE_PERMISSIONS[role] ?? []) {
      set.add(perm);
    }
  }
  return [...set];
}
