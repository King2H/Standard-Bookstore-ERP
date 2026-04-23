/**
 * Layout — hierarchical, accordion-style sidebar + top bar.
 *
 * Sidebar structure:
 *   Dashboard (standalone)
 *   Sales      → POS, Orders, Returns, Exchanges, Customers
 *   Stock      → Inventory, Procurement, Suppliers, Catalog
 *   Finance    → Payments, Installments, Bank Accounts
 *   Organization → Branches, Locations, Staff
 *   System     → Settings, Audit Log
 *
 * Accordion: only one section open at a time.
 * Auto-expand: the section containing the active page opens on mount / page change.
 */
import { useState, useEffect } from 'react';
import { useTheme } from '../lib/theme.js';
import { logout } from '../lib/auth.js';
import NotificationBell from './NotificationBell.js';

type Page =
  | 'dashboard' | 'branches' | 'staff' | 'audit-log' | 'settings'
  | 'bank-accounts' | 'locations' | 'catalog' | 'inventory' | 'suppliers'
  | 'procurement' | 'customers' | 'pos' | 'returns' | 'orders' | 'payments'
  | 'installments' | 'exchanges' | 'profile';

type Role = string;

// ── Menu configuration ────────────────────────────────────────────────────────

interface NavLeaf {
  id: Page;
  label: string;
  icon: string;
  roles: Role[];
}

interface NavSection {
  id: string;
  label: string;
  icon: string;
  roles: Role[];          // section visible if user has ANY of these roles
  items: NavLeaf[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    id: 'sales', label: 'Sales', icon: '🛒',
    roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'],
    items: [
      { id: 'pos',       label: 'POS',       icon: '🛒', roles: ['Admin', 'Manager', 'Sales'] },
      { id: 'orders',    label: 'Orders',    icon: '📦', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'] },
      { id: 'returns',   label: 'Returns',   icon: '↩',  roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'] },
      { id: 'exchanges', label: 'Exchanges', icon: '🔁', roles: ['Admin', 'Manager', 'Sales'] },
      { id: 'customers', label: 'Customers', icon: '👤', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer', 'Stock_Clerk', 'Purchasor'] },
    ],
  },
  {
    id: 'stock', label: 'Stock', icon: '📦',
    roles: ['Admin', 'Manager', 'Stock_Clerk', 'Purchasor', 'Finance_Officer', 'Sales'],
    items: [
      { id: 'inventory',   label: 'Inventory',   icon: '📦', roles: ['Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
      { id: 'procurement', label: 'Procurement', icon: '📋', roles: ['Admin', 'Manager', 'Purchasor', 'Stock_Clerk', 'Finance_Officer'] },
      { id: 'suppliers',   label: 'Suppliers',   icon: '🚚', roles: ['Admin', 'Manager', 'Purchasor'] },
      { id: 'catalog',     label: 'Catalog',     icon: '📚', roles: ['Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
    ],
  },
  {
    id: 'finance', label: 'Finance', icon: '💳',
    roles: ['Admin', 'Manager', 'Finance_Officer', 'Sales'],
    items: [
      { id: 'payments',     label: 'Payments',     icon: '💳', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'] },
      { id: 'installments', label: 'Installments', icon: '📅', roles: ['Admin', 'Manager', 'Sales', 'Finance_Officer'] },
      { id: 'bank-accounts', label: 'Bank Accounts', icon: '🏦', roles: ['Admin', 'Manager', 'Finance_Officer'] },
    ],
  },
  {
    id: 'organization', label: 'Organization', icon: '🏢',
    roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'],
    items: [
      { id: 'branches',  label: 'Branches',  icon: '🏪', roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
      { id: 'locations', label: 'Locations', icon: '📍', roles: ['Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
      { id: 'staff',     label: 'Staff',     icon: '👥', roles: ['Super_Admin', 'Admin', 'Manager'] },
    ],
  },
  {
    id: 'system', label: 'System', icon: '⚙️',
    roles: ['Super_Admin', 'Admin', 'Manager'],
    items: [
      { id: 'settings',  label: 'Settings',  icon: '⚙️', roles: ['Super_Admin', 'Admin', 'Manager'] },
      { id: 'audit-log', label: 'Audit Log', icon: '📋', roles: ['Super_Admin', 'Admin'] },
    ],
  },
];

/** Returns the section id that contains the given page, or null. */
function findSectionForPage(page: Page): string | null {
  for (const section of NAV_SECTIONS) {
    if (section.items.some(i => i.id === page)) return section.id;
  }
  return null;
}

// ── Role badge colours ────────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  Super_Admin:    'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  Admin:          'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  Manager:        'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  Finance_Officer:'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  Stock_Clerk:    'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  Sales:          'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200',
  Purchasor:      'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
};

// ── Sub-components ────────────────────────────────────────────────────────────

interface SidebarItemProps {
  item: NavLeaf;
  isActive: boolean;
  expanded: boolean;
  onClick: () => void;
}

function SidebarItem({ item, isActive, expanded, onClick }: SidebarItemProps) {
  return (
    <button
      onClick={onClick}
      title={!expanded ? item.label : undefined}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150
        ${isActive
          ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
        }`}
    >
      <span className="text-sm flex-shrink-0 w-4 text-center">{item.icon}</span>
      {expanded && (
        <span className="truncate flex-1 text-left">{item.label}</span>
      )}
      {expanded && isActive && (
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
      )}
    </button>
  );
}

interface SidebarSectionProps {
  section: NavSection;
  userRole: Role | null;
  currentPage: Page;
  isOpen: boolean;
  sidebarExpanded: boolean;
  onToggle: () => void;
  onNavigate: (page: Page) => void;
}

function SidebarSection({
  section, userRole, currentPage, isOpen, sidebarExpanded, onToggle, onNavigate,
}: SidebarSectionProps) {
  const visibleItems = section.items.filter(
    item => userRole && item.roles.includes(userRole)
  );
  if (visibleItems.length === 0) return null;

  const hasActiveChild = visibleItems.some(i => i.id === currentPage);

  return (
    <div>
      {/* Section header */}
      <button
        onClick={onToggle}
        title={!sidebarExpanded ? section.label : undefined}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold uppercase tracking-wide transition-all duration-150
          ${hasActiveChild
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/50'
          }`}
      >
        <span className="text-base flex-shrink-0 w-4 text-center">{section.icon}</span>
        {sidebarExpanded && (
          <>
            <span className="flex-1 text-left">{section.label}</span>
            <svg
              className={`w-3.5 h-3.5 flex-shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          </>
        )}
      </button>

      {/* Collapsible items */}
      {(isOpen || !sidebarExpanded) && (
        <div
          className={`overflow-hidden transition-all duration-200 ${
            sidebarExpanded ? 'pl-3 space-y-0.5 mt-0.5' : 'space-y-0.5 mt-0.5'
          }`}
          style={sidebarExpanded ? { maxHeight: isOpen ? '400px' : '0px', opacity: isOpen ? 1 : 0 } : {}}
        >
          {visibleItems.map(item => (
            <SidebarItem
              key={item.id}
              item={item}
              isActive={currentPage === item.id}
              expanded={sidebarExpanded}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

interface LayoutProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
  userRole: Role | null;
  children: React.ReactNode;
}

export default function Layout({ currentPage, onNavigate, onLogout, userRole, children }: LayoutProps) {
  const { theme, toggleTheme } = useTheme();
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  // Accordion: track which section is open
  const [openSection, setOpenSection] = useState<string | null>(() => findSectionForPage(currentPage));

  // Auto-expand the section containing the active page when page changes
  useEffect(() => {
    const section = findSectionForPage(currentPage);
    if (section) setOpenSection(section);
  }, [currentPage]);

  const handleSectionToggle = (sectionId: string) => {
    setOpenSection(prev => (prev === sectionId ? null : sectionId));
  };

  const handleLogout = async () => {
    await logout();
    onLogout();
  };

  // Page title — prettify hyphenated names
  const pageTitle = currentPage
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 transition-colors duration-300">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={`${sidebarExpanded ? 'w-56' : 'w-14'} flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300 ease-in-out`}
      >
        {/* Logo */}
        <div className="h-16 flex items-center px-3 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md">
              <span className="text-white text-sm font-bold">B</span>
            </div>
            {sidebarExpanded && (
              <div>
                <p className="text-sm font-bold text-gray-900 dark:text-white leading-tight">BMS</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 leading-tight">Bookstore ERP</p>
              </div>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto overflow-x-hidden">

          {/* Dashboard — standalone */}
          {userRole && ['Admin', 'Manager', 'Finance_Officer'].includes(userRole) && (
            <button
              onClick={() => onNavigate('dashboard')}
              title={!sidebarExpanded ? 'Dashboard' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150
                ${currentPage === 'dashboard'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
                }`}
            >
              <span className="text-base flex-shrink-0 w-4 text-center">📊</span>
              {sidebarExpanded && <span className="truncate">Dashboard</span>}
              {sidebarExpanded && currentPage === 'dashboard' && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
              )}
            </button>
          )}

          {/* Divider */}
          {sidebarExpanded && <div className="h-px bg-gray-100 dark:bg-gray-800 my-2 mx-1" />}

          {/* Grouped sections */}
          {NAV_SECTIONS.map(section => (
            <SidebarSection
              key={section.id}
              section={section}
              userRole={userRole}
              currentPage={currentPage}
              isOpen={openSection === section.id}
              sidebarExpanded={sidebarExpanded}
              onToggle={() => handleSectionToggle(section.id)}
              onNavigate={onNavigate}
            />
          ))}
        </nav>

        {/* Footer */}
        <div className="p-2 border-t border-gray-200 dark:border-gray-800 space-y-0.5 flex-shrink-0">
          {/* My Profile */}
          <button
            onClick={() => onNavigate('profile')}
            title={!sidebarExpanded ? 'My Profile' : undefined}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150
              ${currentPage === 'profile'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
              }`}
          >
            <span className="text-sm flex-shrink-0 w-4 text-center">👤</span>
            {sidebarExpanded && <span className="truncate">My Profile</span>}
          </button>

          {/* Dark mode */}
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <span className="text-sm flex-shrink-0 w-4 text-center">{theme === 'dark' ? '☀️' : '🌙'}</span>
            {sidebarExpanded && <span className="truncate">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
          </button>

          {/* Sign out */}
          <button
            onClick={handleLogout}
            title={!sidebarExpanded ? 'Sign Out' : undefined}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
          >
            <span className="text-sm flex-shrink-0 w-4 text-center">🚪</span>
            {sidebarExpanded && <span className="truncate">Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top bar */}
        <header className="h-16 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 gap-4 flex-shrink-0">

          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarExpanded(o => !o)}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Page title */}
          <div className="flex-1">
            <h1 className="text-base font-semibold text-gray-900 dark:text-white">{pageTitle}</h1>
          </div>

          {/* Role badge */}
          {userRole && (
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${ROLE_COLORS[userRole] ?? 'bg-gray-100 text-gray-700'}`}>
              {userRole}
            </span>
          )}

          {/* Notification bell */}
          <NotificationBell onNavigate={(page) => onNavigate(page as Page)} />

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Toggle theme"
          >
            {theme === 'dark' ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-950">
          {children}
        </main>
      </div>
    </div>
  );
}
