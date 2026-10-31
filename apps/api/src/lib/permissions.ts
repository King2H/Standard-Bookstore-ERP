export type Permission =
  | 'CREATE_SALE'
  | 'PROCESS_PAYMENT'
  | 'APPROVE_EXCHANGE'
  | 'PROCESS_REFUND'
  | 'ADJUST_PRICE'
  | 'MANAGE_INVENTORY'
  | 'VIEW_REPORTS'
  | 'MANAGE_STAFF'
  | 'MANAGE_BRANCH'
  // Approving and closing purchase orders (owner decision 3a, 2026-10-23).
  | 'APPROVE_PURCHASE_ORDER'
  // Transfers between branches (#170, owner decisions 2a, 4a, 2026-10-26):
  // sending and receiving stock, and resolving what did not arrive.
  | 'SEND_TRANSFER'
  | 'RECEIVE_TRANSFER'
  | 'RESOLVE_TRANSFER'
  // Accepting a cash count over or short beyond the branch's limit (#171, decision 4a).
  | 'REVIEW_CASH_SESSION'
  // Reviewing, posting and cancelling a stock count (#172, decision 4a).
  | 'APPROVE_STOCK_COUNT'
  // Sending books back to a supplier (#173, decision 5a).
  | 'SEND_SUPPLIER_RETURN'
  // Closing a branch's day, the shop's month, and reopening either (#175, decisions 2a, 4a, 5a).
  | 'CLOSE_DAY'
  | 'CLOSE_MONTH'
  | 'REOPEN_PERIOD';

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  // Super_Admin: governance-only role — manages staff, branches, and system config.
  // Intentionally excluded from operational permissions (sales, inventory, finance)
  // so the sidebar correctly shows only Dashboard, Organization, and System.
  Super_Admin: [
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
    'APPROVE_PURCHASE_ORDER',
    'SEND_TRANSFER',
    'RECEIVE_TRANSFER',
    'RESOLVE_TRANSFER',
    'REVIEW_CASH_SESSION',
    'APPROVE_STOCK_COUNT',
    'SEND_SUPPLIER_RETURN',
    'CLOSE_DAY',
    'CLOSE_MONTH',
    'REOPEN_PERIOD',
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
    'APPROVE_PURCHASE_ORDER',
    'SEND_TRANSFER',
    'RECEIVE_TRANSFER',
    'RESOLVE_TRANSFER',
    'REVIEW_CASH_SESSION',
    'APPROVE_STOCK_COUNT',
    'SEND_SUPPLIER_RETURN',
    'CLOSE_DAY',
  ],
  Finance_Officer: ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS', 'CLOSE_DAY', 'CLOSE_MONTH'],
  Stock_Clerk: ['MANAGE_INVENTORY', 'SEND_TRANSFER', 'RECEIVE_TRANSFER'],
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
