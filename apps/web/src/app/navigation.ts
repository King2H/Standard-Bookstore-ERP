/**
 * The pages of the app, their URLs, and who may open them (#23, ADR-0011).
 *
 * One rule decides both what the sidebar shows and which URLs a user may
 * open, so a page hidden from someone's menu is also closed to them when they
 * type its address, follow a notification or press Back.
 *
 * Sidebar structure:
 *   Dashboard (standalone)
 *   Sales      → POS, Orders, Returns, Exchanges, Customers
 *   Stock      → Inventory, Procurement, Suppliers, Catalog
 *   Finance    → Payments, Receivables
 *     (Bank Accounts is not an active module for this version: hidden
 *      from the nav, route/page left intact.)
 *   Organization → Branches, Locations, Staff
 *   System     → Settings, Audit Log
 */

export type Page =
  | 'dashboard' | 'branches' | 'staff' | 'audit-log' | 'settings'
  | 'bank-accounts' | 'locations' | 'catalog' | 'inventory' | 'suppliers'
  | 'procurement' | 'customers' | 'pos' | 'returns' | 'orders' | 'payments'
  | 'exchanges' | 'profile' | 'receivables';

export const PAGES: readonly Page[] = [
  'dashboard', 'branches', 'staff', 'audit-log', 'settings', 'bank-accounts', 'locations', 'catalog',
  'inventory', 'suppliers', 'procurement', 'customers', 'pos', 'returns', 'orders', 'payments',
  'exchanges', 'profile', 'receivables',
];

export const isPage = (value: string): value is Page => (PAGES as readonly string[]).includes(value);

/** The URL of a page; `context` (filters a dashboard card or a notification hands over) goes in the query string. */
export function pagePath(page: Page, context?: Record<string, string>): string {
  const query = new URLSearchParams(context ?? {}).toString();
  return `/${page}${query ? `?${query}` : ''}`;
}

type Role = string;

// ── Permission → menu mapping ─────────────────────────────────────────────────
// Each menu item lists which permissions grant access to it.
// A user sees an item if they have ANY of the listed permissions.
// This supports multi-role users: permissions are the union of all their roles.

export interface NavLeaf {
  id: Page;
  label: string;
  icon: string;
  roles: Role[];           // kept for backward compat / role-badge display
  permissions?: string[];  // if set, used instead of roles for visibility
}

export interface NavSection {
  id: string;
  label: string;
  icon: string;
  roles: Role[];
  permissions?: string[];
  items: NavLeaf[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'sales', label: 'Sales', icon: '🛒',
    roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'],
    permissions: ['CREATE_SALE', 'PROCESS_PAYMENT', 'APPROVE_EXCHANGE', 'PROCESS_REFUND'],
    items: [
      { id: 'pos',       label: 'POS',       icon: '🛒', roles: ['Admin', 'Manager', 'Sales'],                                    permissions: ['CREATE_SALE'] },
      { id: 'orders',    label: 'Orders',    icon: '📦', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'],                  permissions: ['CREATE_SALE', 'PROCESS_PAYMENT'] },
      { id: 'returns',   label: 'Returns',   icon: '↩',  roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'],                  permissions: ['CREATE_SALE', 'PROCESS_REFUND'] },
      { id: 'exchanges', label: 'Exchanges', icon: '🔁', roles: ['Admin', 'Manager', 'Sales'],                                    permissions: ['CREATE_SALE', 'APPROVE_EXCHANGE'] },
      { id: 'customers', label: 'Customers', icon: '👤', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer', 'Stock_Clerk', 'Purchasor'], permissions: ['CREATE_SALE', 'PROCESS_PAYMENT', 'MANAGE_INVENTORY', 'VIEW_REPORTS'] },
    ],
  },
  {
    id: 'stock', label: 'Stock', icon: '📦',
    roles: ['Admin', 'Manager', 'Stock_Clerk', 'Purchasor', 'Finance_Officer', 'Sales'],
    permissions: ['MANAGE_INVENTORY', 'VIEW_REPORTS'],
    items: [
      { id: 'inventory',   label: 'Inventory',   icon: '📦', roles: ['Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'], permissions: ['MANAGE_INVENTORY', 'VIEW_REPORTS'] },
      { id: 'procurement', label: 'Procurement', icon: '📋', roles: ['Admin', 'Manager', 'Purchasor', 'Stock_Clerk', 'Finance_Officer'],           permissions: ['MANAGE_INVENTORY'] },
      { id: 'suppliers',   label: 'Suppliers',   icon: '🚚', roles: ['Admin', 'Manager', 'Purchasor'],                                             permissions: ['MANAGE_INVENTORY'] },
      { id: 'catalog',     label: 'Catalog',     icon: '📚', roles: ['Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'],  permissions: ['MANAGE_INVENTORY', 'VIEW_REPORTS', 'CREATE_SALE'] },
    ],
  },
  {
    id: 'finance', label: 'Finance', icon: '💳',
    roles: ['Admin', 'Manager', 'Finance_Officer', 'Sales'],
    permissions: ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS'],
    items: [
      { id: 'payments',      label: 'Payments',      icon: '💳', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'],  permissions: ['PROCESS_PAYMENT', 'PROCESS_REFUND'] },
      { id: 'receivables',   label: 'Receivables',   icon: '🧾', roles: ['Admin', 'Manager', 'Finance_Officer'],             permissions: ['PROCESS_PAYMENT'] },
      // 'bank-accounts' intentionally omitted — not an active module for
      // this version. The page/route still exists; only the nav entry is
      // hidden. (Installments were retired.)
    ],
  },
  {
    id: 'organization', label: 'Organization', icon: '🏢',
    roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'],
    items: [
      { id: 'branches',  label: 'Branches',  icon: '🏪', roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
      { id: 'locations', label: 'Locations', icon: '📍', roles: ['Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'],               permissions: ['MANAGE_BRANCH', 'MANAGE_INVENTORY', 'CREATE_SALE'] },
      { id: 'staff',     label: 'Staff',     icon: '👥', roles: ['Super_Admin', 'Admin', 'Manager'],                                                        permissions: ['MANAGE_STAFF'] },
    ],
  },
  {
    id: 'system', label: 'System', icon: '⚙️',
    roles: ['Super_Admin', 'Admin', 'Manager'],
    permissions: ['MANAGE_BRANCH', 'MANAGE_STAFF'],
    items: [
      { id: 'settings',  label: 'Settings',  icon: '⚙️', roles: ['Super_Admin', 'Admin', 'Manager'], permissions: ['MANAGE_BRANCH'] },
      { id: 'audit-log', label: 'Audit Log', icon: '📋', roles: ['Super_Admin', 'Admin'],             permissions: ['MANAGE_STAFF', 'MANAGE_BRANCH'] },
    ],
  },
];

/** Returns the section id that contains the given page, or null. */
export function findSectionForPage(page: Page): string | null {
  for (const section of NAV_SECTIONS) {
    if (section.items.some(i => i.id === page)) return section.id;
  }
  return null;
}

/** Returns true if the user can see this item based on their role OR permissions. */
export function canSeeItem(item: NavLeaf, userRole: Role | null, userPermissions: string[]): boolean {
  // Super_Admin is a governance-only role: Dashboard, Organization, System only.
  // Block all operational sections regardless of any permission union.
  if (userRole === 'Super_Admin') {
    const SUPER_ADMIN_ALLOWED: Page[] = [
      'dashboard', 'branches', 'locations', 'staff', 'settings', 'audit-log', 'profile',
    ];
    return SUPER_ADMIN_ALLOWED.includes(item.id);
  }

  // Permission-based check (preferred — supports multi-role union)
  if (item.permissions && item.permissions.length > 0) {
    if (userPermissions.some(p => item.permissions!.includes(p))) return true;
  }
  // Role-based fallback (for items without permission mapping, or when permissions not yet loaded)
  if (userRole && item.roles.includes(userRole)) return true;
  return false;
}

/** Dashboard — standalone, visible to roles with VIEW_REPORTS or Admin/Manager. */
export function canSeeDashboard(userRole: Role | null, userPermissions: string[]): boolean {
  return userPermissions.some(p => ['VIEW_REPORTS', 'MANAGE_BRANCH'].includes(p)) ||
    (!!userRole && ['Admin', 'Manager', 'Finance_Officer', 'Super_Admin'].includes(userRole));
}

// Not in the menu, but open to those who could use it: the page's own
// reconcile rule. The API answers it only with FEATURE_BANK_ACCOUNTS=true.
const BANK_ACCOUNTS: NavLeaf = { id: 'bank-accounts', label: 'Bank Accounts', icon: '🏦', roles: ['Admin', 'Manager', 'Finance_Officer'] };

/** Whether the user may open the page: the same rule the sidebar shows it by. */
export function canOpenPage(page: Page, userRole: Role | null, userPermissions: string[]): boolean {
  if (page === 'profile') return true;
  if (page === 'dashboard') return canSeeDashboard(userRole, userPermissions);
  if (page === 'bank-accounts') return canSeeItem(BANK_ACCOUNTS, userRole, userPermissions);
  const item = NAV_SECTIONS.flatMap(s => s.items).find(i => i.id === page);
  return !!item && canSeeItem(item, userRole, userPermissions);
}

/** The page a role starts on after signing in or switching branch. */
export function landingPage(role: Role | null): Page {
  if (role === 'Super_Admin' || role === 'Admin') return 'dashboard';
  if (role === 'Manager' || role === 'Finance_Officer') return 'dashboard';
  if (role === 'Sales') return 'pos';
  if (role === 'Stock_Clerk') return 'inventory';
  if (role === 'Purchasor') return 'procurement';
  return 'branches';
}
