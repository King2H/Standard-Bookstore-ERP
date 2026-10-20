import { Fragment } from 'react';
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router';
import BranchesPage from '../features/branches/pages/BranchesPage.js';
import StaffPage from '../features/staff/pages/StaffPage.js';
import AuditLogPage from '../features/auditLog/pages/AuditLogPage.js';
import SettingsPage from '../features/settings/pages/SettingsPage.js';
import BankAccountsPage from '../features/bankAccounts/pages/BankAccountsPage.js';
import LocationsPage from '../features/locations/pages/LocationsPage.js';
import CatalogPage from '../features/catalog/pages/CatalogPage.js';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import SuppliersPage from '../features/suppliers/pages/SuppliersPage.js';
import ProcurementPage from '../features/procurement/pages/ProcurementPage.js';
import CustomersPage from '../features/customers/pages/CustomersPage.js';
import PosPage from '../features/pos/pages/PosPage.js';
import ReturnsPage from '../features/returns/pages/ReturnsPage.js';
import OrdersPage from '../features/orders/pages/OrdersPage.js';
import PaymentsPage from '../features/payments/pages/PaymentsPage.js';
import ExchangesPage from '../features/exchanges/pages/ExchangesPage.js';
import ReceivablesPage from '../features/receivables/pages/ReceivablesPage.js';
import DashboardPage from '../features/dashboard/pages/DashboardPage.js';
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
        {page === 'dashboard'    && <DashboardPage userRole={userRole} userPermissions={userPermissions} onNavigate={navigateTo} />}
        {page === 'branches'     && <BranchesPage />}
        {page === 'staff'        && <StaffPage />}
        {page === 'audit-log'    && <AuditLogPage />}
        {page === 'settings'     && <SettingsPage />}
        {page === 'bank-accounts'&& <BankAccountsPage />}
        {page === 'locations'    && <LocationsPage />}
        {page === 'catalog'      && <CatalogPage />}
        {page === 'inventory'    && <InventoryPage initialContext={initialContext} />}
        {page === 'suppliers'    && <SuppliersPage userRole={role} userPermissions={userPermissions} />}
        {page === 'procurement'  && <ProcurementPage initialContext={initialContext} />}
        {page === 'customers'    && <CustomersPage />}
        {page === 'pos'          && <PosPage userRole={role} userPermissions={userPermissions} initialContext={initialContext} onNavigate={navigateTo} />}
        {page === 'returns'      && <ReturnsPage />}
        {page === 'orders'       && <OrdersPage initialContext={initialContext} onNavigate={navigateTo} />}
        {page === 'payments'     && <PaymentsPage initialContext={initialContext} />}
        {page === 'exchanges'    && <ExchangesPage />}
        {page === 'receivables'  && <ReceivablesPage initialContext={initialContext} onNavigate={navigateTo} />}
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
