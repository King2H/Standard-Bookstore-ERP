import { Fragment } from 'react';
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router';
import BranchesPage from '../features/branches/pages/BranchesPage.js';
import StaffPage from '../features/staff/pages/StaffPage.js';
import AuditLogPage from '../features/auditLog/pages/AuditLogPage.js';
import SettingsPage from '../features/settings/pages/SettingsPage.js';
import BankAccountsPage from '../pages/BankAccountsPage.js';
import LocationsPage from '../features/locations/pages/LocationsPage.js';
import CatalogPage from '../pages/CatalogPage.js';
import InventoryPage from '../pages/InventoryPage.js';
import SuppliersPage from '../features/suppliers/pages/SuppliersPage.js';
import ProcurementPage from '../pages/ProcurementPage.js';
import CustomersPage from '../pages/CustomersPage.js';
import POSPage from '../pages/POSPage.js';
import ReturnsPage from '../pages/ReturnsPage.js';
import OrdersPage from '../pages/OrdersPage.js';
import PaymentsPage from '../pages/PaymentsPage.js';
import ExchangesPage from '../pages/ExchangesPage.js';
import ReceivablesPage from '../pages/ReceivablesPage.js';
import DashboardPage from '../pages/DashboardPage.js';
import ProfilePage from '../features/account/pages/ProfilePage.js';
import { canOpenPage, isPage, landingPage, pagePath, type Page } from './navigation.js';
import type { Session } from './useSession.js';

/** One route per page, each behind its guard; any other address goes to the landing page. */
export function AppRoutes({ session, onNavigate }: {
  session: Session;
  onNavigate: (page: Page, context?: Record<string, string>) => void;
}) {
  const { userRole, userPermissions } = session;
  const role = userRole ?? undefined;
  const navigateTo = (page: string, context?: Record<string, string>) => onNavigate(page as Page, context);

  return (
    <Routes>
      <Route path="/:page" element={<PageRoute session={session} render={(page, initialContext) => <>
        {page === 'dashboard'    && <DashboardPage userRole={role} onNavigate={navigateTo} />}
        {page === 'branches'     && <BranchesPage />}
        {page === 'staff'        && <StaffPage />}
        {page === 'audit-log'    && <AuditLogPage />}
        {page === 'settings'     && <SettingsPage />}
        {page === 'bank-accounts'&& <BankAccountsPage userRole={role} />}
        {page === 'locations'    && <LocationsPage />}
        {page === 'catalog'      && <CatalogPage userRole={role} userPermissions={userPermissions} />}
        {page === 'inventory'    && <InventoryPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} />}
        {page === 'suppliers'    && <SuppliersPage userRole={role} userPermissions={userPermissions} />}
        {page === 'procurement'  && <ProcurementPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} />}
        {page === 'customers'    && <CustomersPage userRole={role} userPermissions={userPermissions} />}
        {page === 'pos'          && <POSPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={navigateTo} />}
        {page === 'returns'      && <ReturnsPage userRole={role} userPermissions={userPermissions} />}
        {page === 'orders'       && <OrdersPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={navigateTo} />}
        {page === 'payments'     && <PaymentsPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} />}
        {page === 'exchanges'    && <ExchangesPage userRole={role} userPermissions={userPermissions} />}
        {page === 'receivables'  && <ReceivablesPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={navigateTo} />}
        {page === 'profile'      && <ProfilePage onPasswordChanged={session.passwordChanged} />}
      </>} />} />
      <Route path="*" element={<Navigate to={pagePath(allowedLanding(session))} replace />} />
    </Routes>
  );
}

type Access = Pick<Session, 'userRole' | 'userPermissions' | 'mustChangePassword'>;

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
function PageRoute({ session, render }: {
  session: Access;
  render: (page: Page, initialContext: Record<string, string>) => React.ReactNode;
}) {
  const { page = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { userRole, userPermissions, mustChangePassword } = session;
  const allowed = isPage(page) && (mustChangePassword ? page === 'profile' : canOpenPage(page, userRole, userPermissions));
  if (!allowed) return <Navigate to={pagePath(allowedLanding(session))} replace />;
  // A new query string (another order to collect, other filters) starts the page afresh.
  return <Fragment key={searchParams.toString()}>{render(page, Object.fromEntries(searchParams))}</Fragment>;
}
