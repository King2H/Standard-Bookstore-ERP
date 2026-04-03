import { useState } from 'react';
import { useTheme } from '../lib/theme.js';
import { logout } from '../lib/auth.js';

type Page = 'branches' | 'staff' | 'audit-log' | 'settings' | 'bank-accounts' | 'locations' | 'profile';
type Role = string;

interface NavItem {
  id: Page;
  label: string;
  icon: string;
  roles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { id: 'branches',      label: 'Branches',      icon: '🏪', roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
  { id: 'staff',         label: 'Staff',         icon: '👥', roles: ['Super_Admin', 'Admin', 'Manager'] },
  { id: 'locations',     label: 'Locations',     icon: '📍', roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] },
  { id: 'bank-accounts', label: 'Bank Accounts', icon: '🏦', roles: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer'] },
  { id: 'settings',      label: 'Settings',      icon: '⚙️', roles: ['Super_Admin', 'Admin', 'Manager'] },
  { id: 'audit-log',     label: 'Audit Log',     icon: '📋', roles: ['Super_Admin', 'Admin'] },
];

interface LayoutProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
  userRole: Role | null;
  children: React.ReactNode;
}

export default function Layout({ currentPage, onNavigate, onLogout, userRole, children }: LayoutProps) {
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const visibleNav = NAV_ITEMS.filter(item =>
    userRole ? item.roles.includes(userRole) : false
  );

  const handleLogout = async () => {
    await logout();
    onLogout();
  };

  const roleColors: Record<string, string> = {
    Super_Admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    Admin: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    Manager: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    Finance_Officer: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    Stock_Clerk: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    Sales: 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200',
    Purchasor: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  };

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 transition-colors duration-300">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className={`${sidebarOpen ? 'w-56' : 'w-16'} flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300 ease-in-out`}>

        {/* Logo area */}
        <div className="h-16 flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md">
              <span className="text-white text-sm font-bold">B</span>
            </div>
            {sidebarOpen && (
              <div className="animate-fade-in">
                <p className="text-sm font-bold text-gray-900 dark:text-white leading-tight">BMS</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 leading-tight">Bookstore ERP</p>
              </div>
            )}
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-4 px-2 space-y-1">
          {visibleNav.map(item => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group
                ${currentPage === item.id
                  ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 shadow-sm'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
                }`}
            >
              <span className="text-base flex-shrink-0">{item.icon}</span>
              {sidebarOpen && (
                <span className="animate-fade-in truncate">{item.label}</span>
              )}
              {sidebarOpen && currentPage === item.id && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
              )}
            </button>
          ))}
        </nav>

        {/* Sidebar footer */}
        <div className="p-2 border-t border-gray-200 dark:border-gray-800 space-y-1">
          {/* My Profile */}
          <button
            onClick={() => onNavigate('profile')}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150
              ${currentPage === 'profile'
                ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
              }`}
          >
            <span className="text-base flex-shrink-0">👤</span>
            {sidebarOpen && <span className="animate-fade-in truncate">My Profile</span>}
          </button>

          {/* Dark mode toggle */}
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <span className="text-base flex-shrink-0">{theme === 'dark' ? '☀️' : '🌙'}</span>
            {sidebarOpen && <span className="animate-fade-in">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
          >
            <span className="text-base flex-shrink-0">🚪</span>
            {sidebarOpen && <span className="animate-fade-in">Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top bar */}
        <header className="h-16 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 gap-4 flex-shrink-0">

          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Page title */}
          <div className="flex-1">
            <h1 className="text-base font-semibold text-gray-900 dark:text-white capitalize">
              {currentPage.replace('-', ' ')}
            </h1>
          </div>

          {/* Role badge */}
          {userRole && (
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${roleColors[userRole] ?? 'bg-gray-100 text-gray-700'}`}>
              {userRole}
            </span>
          )}

          {/* Dark mode quick toggle */}
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
        <main className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-950 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
