import { useState, useEffect, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LoginPage from './pages/LoginPage.js';
import BranchesPage from './pages/BranchesPage.js';
import StaffPage from './pages/StaffPage.js';
import AuditLogPage from './pages/AuditLogPage.js';
import SettingsPage from './pages/SettingsPage.js';
import BankAccountsPage from './pages/BankAccountsPage.js';
import LocationsPage from './pages/LocationsPage.js';
import CatalogPage from './pages/CatalogPage.js';
import InventoryPage from './pages/InventoryPage.js';
import SuppliersPage from './pages/SuppliersPage.js';
import ProcurementPage from './pages/ProcurementPage.js';
import CustomersPage from './pages/CustomersPage.js';
import POSPage from './pages/POSPage.js';
import ReturnsPage from './pages/ReturnsPage.js';
import OrdersPage from './pages/OrdersPage.js';
import PaymentsPage from './pages/PaymentsPage.js';
import ExchangesPage from './pages/ExchangesPage.js';
import InstallmentsPage from './pages/InstallmentsPage.js';
import ReceivablesPage from './pages/ReceivablesPage.js';
import DashboardPage from './pages/DashboardPage.js';
import ProfilePage from './pages/ProfilePage.js';
import { ToastProvider } from './components/Toast.js';
import { ThemeProvider } from './lib/theme.js';
import Layout from './components/Layout.js';
import SessionWarning from './components/SessionWarning.js';
import { getAccessToken } from './lib/api.js';
import { logout as doLogout, restoreSession, switchBranch } from './lib/auth.js';
import { startInactivityTimer, stopInactivityTimer } from './lib/session.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

type Page = 'dashboard' | 'branches' | 'staff' | 'audit-log' | 'settings' | 'bank-accounts' | 'locations' | 'catalog' | 'inventory' | 'suppliers' | 'procurement' | 'customers' | 'pos' | 'returns' | 'orders' | 'payments' | 'installments' | 'exchanges' | 'profile' | 'receivables';
type Role = 'Super_Admin' | 'Admin' | 'Manager' | 'Finance_Officer' | 'Stock_Clerk' | 'Sales' | 'Purchasor';

/** Parse all fields needed from the JWT in one pass. */
function parseTokenPayload(): { role: Role | null; roles: string[]; branchId: number | null } {
  const token = getAccessToken();
  if (!token) return { role: null, roles: [], branchId: null };
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    const role = (p.role as Role) ?? null;
    const roles: string[] = Array.isArray(p.roles) ? p.roles : (role ? [role] : []);
    const branchId = typeof p.branchId === 'number' ? p.branchId : null;
    return { role, roles, branchId };
  } catch {
    return { role: null, roles: [], branchId: null };
  }
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sessionRestoring, setSessionRestoring] = useState(true);
  const [currentPage, setCurrentPage] = useState<Page>('branches');
  const [userRole, setUserRole] = useState<Role | null>(null);
  const [userRoles, setUserRoles] = useState<string[]>([]);       // all roles for active branch
  const [userPermissions, setUserPermissions] = useState<string[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<number | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [warningSeconds, setWarningSeconds] = useState(0);

  // ── Session restore on app load ────────────────────────────────────────────
  // Always attempt a silent token refresh on mount. The refresh token lives in
  // an HTTP-only session cookie (no maxAge → cleared when browser closes).
  //
  //   Cookie present + valid  → restore session, stay logged in
  //   Cookie absent / expired → show login page
  //
  // This is the standard industry pattern. The session cookie being a
  // "session cookie" (no maxAge) means it is automatically cleared when the
  // browser window closes, so a fresh browser launch always requires login.
  useEffect(() => {
    restoreSession().then(({ restored, permissions }) => {
      if (restored) {
        const { role, roles, branchId } = parseTokenPayload();
        setUserRole(role);
        setUserRoles(roles);
        setUserPermissions(permissions);
        setActiveBranchId(branchId);
        setIsAuthenticated(true);
        applyRoleLanding(role);
      }
      setSessionRestoring(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Inactivity timer — start when authenticated, stop on logout ────────────
  const handleInactivityLogout = useCallback(() => {
    doLogout().catch(() => {});
    stopInactivityTimer();
    setIsAuthenticated(false);
    setUserRole(null);
    setUserRoles([]);
    setActiveBranchId(null);
    setMustChangePassword(false);
    setCurrentPage('branches');
    setWarningSeconds(0);
  }, []);

  const handleWarning = useCallback((seconds: number) => {
    setWarningSeconds(seconds);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      startInactivityTimer(handleInactivityLogout, handleWarning);
    } else if (!sessionRestoring) {
      // Don't stop the timer during the initial restore check — only stop it
      // once we know for certain the user is logged out.
      stopInactivityTimer();
      setWarningSeconds(0);
    }
  }, [isAuthenticated, sessionRestoring, handleInactivityLogout, handleWarning]);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function applyRoleLanding(role: Role | null) {
    if (role === 'Super_Admin' || role === 'Admin') setCurrentPage('dashboard');
    else if (role === 'Manager' || role === 'Finance_Officer') setCurrentPage('dashboard');
    else if (role === 'Sales') setCurrentPage('pos');
    else if (role === 'Stock_Clerk') setCurrentPage('inventory');
    else if (role === 'Purchasor') setCurrentPage('procurement');
    else setCurrentPage('branches');
  }

  const handleLoginSuccess = (opts?: { mustChangePassword?: boolean; permissions?: string[] }) => {
    setIsAuthenticated(true);
    const { role, roles, branchId } = parseTokenPayload();
    setUserRole(role);
    setUserRoles(roles);
    setActiveBranchId(branchId);
    setUserPermissions(opts?.permissions ?? []);
    if (opts?.mustChangePassword) {
      setMustChangePassword(true);
      setCurrentPage('profile');
      return;
    }
    applyRoleLanding(role);
  };

  const handleNavigate = (page: Page) => {
    if (mustChangePassword && page !== 'profile') return;
    setCurrentPage(page);
  };

  const handleLogout = async () => {
    await doLogout();
    stopInactivityTimer();
    setIsAuthenticated(false);
    setUserRole(null);
    setUserRoles([]);
    setUserPermissions([]);
    setActiveBranchId(null);
    setMustChangePassword(false);
    setCurrentPage('branches');
    setWarningSeconds(0);
  };

  // ── Branch switcher ──────────────────────────────────────────────────────
  const handleSwitchBranch = async (branchId: number) => {
    try {
      const { permissions } = await switchBranch(branchId);
      const { role, roles } = parseTokenPayload();
      setUserRole(role);
      setUserRoles(roles);
      setUserPermissions(permissions);
      setActiveBranchId(branchId);
      // Re-apply landing page for the new role context
      applyRoleLanding(role);
      // Invalidate all cached queries so data refreshes for the new branch
      queryClient.invalidateQueries();
    } catch {
      // If switch fails (e.g. no access), silently ignore — user stays on current branch
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  // Show a spinner while checking the refresh token cookie on app load.
  // This prevents a flash of the login page before the restore check completes.
  if (sessionRestoring) {
    return (
      <ThemeProvider>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-400">Restoring session…</p>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {!isAuthenticated ? (
            <LoginPage onSuccess={handleLoginSuccess} />
          ) : (
            <Layout
              currentPage={currentPage}
              onNavigate={handleNavigate}
              onLogout={handleLogout}
              userRole={userRole}
              userRoles={userRoles}
              userPermissions={userPermissions}
              activeBranchId={activeBranchId}
              onSwitchBranch={handleSwitchBranch}
            >
              {mustChangePassword && (
                <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 px-4 py-2 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
                  <span>⚠️</span>
                  <span>You must change your password before continuing. Please update it in your profile.</span>
                </div>
              )}
              {currentPage === 'dashboard'    && <DashboardPage userRole={userRole ?? undefined} onNavigate={(page) => handleNavigate(page as Page)} />}
              {currentPage === 'branches'     && <BranchesPage userRole={userRole ?? undefined} />}
              {currentPage === 'staff'        && <StaffPage />}
              {currentPage === 'audit-log'    && <AuditLogPage />}
              {currentPage === 'settings'     && <SettingsPage userRole={userRole ?? undefined} />}
              {currentPage === 'bank-accounts'&& <BankAccountsPage userRole={userRole ?? undefined} />}
              {currentPage === 'locations'    && <LocationsPage userRole={userRole ?? undefined} />}
              {currentPage === 'catalog'      && <CatalogPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'inventory'    && <InventoryPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'suppliers'    && <SuppliersPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'procurement'  && <ProcurementPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'customers'    && <CustomersPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'pos'          && <POSPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'returns'      && <ReturnsPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'orders'       && <OrdersPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'payments'     && <PaymentsPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'installments' && <InstallmentsPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'exchanges'    && <ExchangesPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'receivables'  && <ReceivablesPage userRole={userRole ?? undefined} userPermissions={userPermissions} />}
              {currentPage === 'profile'      && <ProfilePage />}

              {/* Inactivity warning overlay */}
              <SessionWarning
                secondsLeft={warningSeconds}
                onStayLoggedIn={() => setWarningSeconds(0)}
                onLogoutNow={handleLogout}
              />
            </Layout>
          )}
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
