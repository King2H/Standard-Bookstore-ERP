import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
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
import ReceivablesPage from './pages/ReceivablesPage.js';
import DashboardPage from './pages/DashboardPage.js';
import ProfilePage from './pages/ProfilePage.js';
import { ToastProvider } from './components/Toast.js';
import { ThemeProvider } from './lib/theme.js';
import Layout from './components/Layout.js';
import SessionWarning from './components/SessionWarning.js';
import { getAccessToken } from './lib/api.js';
import { logout as doLogout, restoreSession, switchBranch } from './lib/auth.js';
import { setPasswordChangeRequiredHandler, setSessionEndedHandler } from './lib/api.js';
import { startInactivityTimer, stopInactivityTimer } from './lib/session.js';
import { canOpenPage, isPage, landingPage, pagePath, type Page } from './app/navigation.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

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
  const navigate = useNavigate();
  const location = useLocation();
  // Read through a ref by the long-lived callbacks below, so a new page does
  // not restart the inactivity timer.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sessionRestoring, setSessionRestoring] = useState(true);
  const [userRole, setUserRole] = useState<Role | null>(null);
  const [userRoles, setUserRoles] = useState<string[]>([]);       // all roles for active branch
  const [userPermissions, setUserPermissions] = useState<string[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<number | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [warningSeconds, setWarningSeconds] = useState(0);

  // The page is the first part of the URL (#23): /orders, /payments?orderId=…
  const urlPage = location.pathname.split('/')[1] ?? '';
  const currentPage: Page = isPage(urlPage) ? urlPage : landingPage(userRole);

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
  //
  // A restored session stays on the page in the URL (a reload, a bookmark);
  // only the bare address goes to the role's landing page.
  //
  // hasAttemptedRestore guards against React StrictMode's dev-only double
  // effect invocation (mount → cleanup → mount), which would otherwise fire
  // /auth/refresh twice on every load and log a duplicate 401 in the console
  // when there's no session cookie yet. Without the guard the behavior is
  // still correct (a second identical request is idempotent), just noisy.
  const hasAttemptedRestore = useRef(false);
  useEffect(() => {
    if (hasAttemptedRestore.current) return;
    hasAttemptedRestore.current = true;
    restoreSession().then(({ restored, permissions, mustChangePassword: mustChange }) => {
      if (restored) {
        const { role, roles, branchId } = parseTokenPayload();
        setUserRole(role);
        setUserRoles(roles);
        setUserPermissions(permissions);
        setActiveBranchId(branchId);
        setIsAuthenticated(true);
        if (mustChange) requirePasswordChange();
        else if (!isPage(urlPage)) applyRoleLanding(role);
      }
      setSessionRestoring(false);
    });
  }, []);

  // The API refuses everything else until the password is changed (#38);
  // whichever request hits that first brings the user to their profile.
  useEffect(() => {
    setPasswordChangeRequiredHandler(requirePasswordChange);
    return () => setPasswordChangeRequiredHandler(null);
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
    navigateRef.current('/', { replace: true });
    setWarningSeconds(0);
  }, []);

  const handleWarning = useCallback((seconds: number) => {
    setWarningSeconds(seconds);
  }, []);

  // A session ended on the server (#21) signs the user out here too.
  useEffect(() => {
    setSessionEndedHandler(handleInactivityLogout);
    return () => setSessionEndedHandler(null);
  }, [handleInactivityLogout]);

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

  function requirePasswordChange() {
    setMustChangePassword(true);
    navigateRef.current(pagePath('profile'), { replace: true });
  }

  const handlePasswordChanged = () => {
    if (!mustChangePassword) return;
    setMustChangePassword(false);
    applyRoleLanding(userRole);
    queryClient.invalidateQueries();
  };

  function applyRoleLanding(role: Role | null) {
    navigateRef.current(pagePath(landingPage(role)), { replace: true });
  }

  const handleLoginSuccess = (opts?: { mustChangePassword?: boolean; permissions?: string[] }) => {
    setIsAuthenticated(true);
    const { role, roles, branchId } = parseTokenPayload();
    setUserRole(role);
    setUserRoles(roles);
    setActiveBranchId(branchId);
    setUserPermissions(opts?.permissions ?? []);
    if (opts?.mustChangePassword) {
      requirePasswordChange();
      return;
    }
    if (!isPage(urlPage)) applyRoleLanding(role);
  };

  const handleNavigate = (page: Page, context?: Record<string, string>) => {
    if (mustChangePassword && page !== 'profile') return;
    navigate(pagePath(page, context));
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
    navigate('/', { replace: true });
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
      if (mustChangePassword) navigate(pagePath('profile'), { replace: true });
      else applyRoleLanding(role);
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

  const access: Access = { userRole, userPermissions, mustChangePassword };
  const onNavigate = (page: string, context?: Record<string, string>) => handleNavigate(page as Page, context);
  const role = userRole ?? undefined;

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
                  <span>Your password must be changed before continuing. Please update it in your profile.</span>
                </div>
              )}
              <Routes>
                <Route path="/:page" element={<PageRoute access={access} render={(page, initialContext) => <>
                  {page === 'dashboard'    && <DashboardPage userRole={role} onNavigate={onNavigate} />}
                  {page === 'branches'     && <BranchesPage userRole={role} />}
                  {page === 'staff'        && <StaffPage userRoles={userRoles} />}
                  {page === 'audit-log'    && <AuditLogPage />}
                  {page === 'settings'     && <SettingsPage userRole={role} />}
                  {page === 'bank-accounts'&& <BankAccountsPage userRole={role} />}
                  {page === 'locations'    && <LocationsPage userRole={role} />}
                  {page === 'catalog'      && <CatalogPage userRole={role} userPermissions={userPermissions} />}
                  {page === 'inventory'    && <InventoryPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} />}
                  {page === 'suppliers'    && <SuppliersPage userRole={role} userPermissions={userPermissions} />}
                  {page === 'procurement'  && <ProcurementPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} />}
                  {page === 'customers'    && <CustomersPage userRole={role} userPermissions={userPermissions} />}
                  {page === 'pos'          && <POSPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={onNavigate} />}
                  {page === 'returns'      && <ReturnsPage userRole={role} userPermissions={userPermissions} />}
                  {page === 'orders'       && <OrdersPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={onNavigate} />}
                  {page === 'payments'     && <PaymentsPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} />}
                  {page === 'exchanges'    && <ExchangesPage userRole={role} userPermissions={userPermissions} />}
                  {page === 'receivables'  && <ReceivablesPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={onNavigate} />}
                  {page === 'profile'      && <ProfilePage onPasswordChanged={handlePasswordChanged} />}
                </>} />} />
                <Route path="*" element={<Navigate to={pagePath(allowedLanding(access))} replace />} />
              </Routes>

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

interface Access { userRole: Role | null; userPermissions: string[]; mustChangePassword: boolean }

/** The role's landing page, or the profile when the role may not open even that. */
function allowedLanding({ userRole, userPermissions, mustChangePassword }: Access): Page {
  const landing = landingPage(userRole);
  return !mustChangePassword && canOpenPage(landing, userRole, userPermissions) ? landing : 'profile';
}

/**
 * Route guard: the page in the URL renders only when the user may open it
 * (the rule the sidebar shows it by), and only the profile while the password
 * must be changed. Anything else goes to the landing page, replacing the
 * refused address in the history so Back does not return to it.
 */
function PageRoute({ access, render }: {
  access: Access;
  render: (page: Page, initialContext: Record<string, string>) => React.ReactNode;
}) {
  const { page = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { userRole, userPermissions, mustChangePassword } = access;
  const allowed = isPage(page) && (mustChangePassword ? page === 'profile' : canOpenPage(page, userRole, userPermissions));
  if (!allowed) return <Navigate to={pagePath(allowedLanding(access))} replace />;
  // A new query string (another order to collect, other filters) starts the page afresh.
  return <Fragment key={searchParams.toString()}>{render(page, Object.fromEntries(searchParams))}</Fragment>;
}
