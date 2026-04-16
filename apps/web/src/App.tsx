import { useState } from 'react';
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
import DashboardPage from './pages/DashboardPage.js';
import ProfilePage from './pages/ProfilePage.js';
import { ToastProvider } from './components/Toast.js';
import { ThemeProvider } from './lib/theme.js';
import Layout from './components/Layout.js';
import { getAccessToken } from './lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

type Page = 'dashboard' | 'branches' | 'staff' | 'audit-log' | 'settings' | 'bank-accounts' | 'locations' | 'catalog' | 'inventory' | 'suppliers' | 'procurement' | 'customers' | 'pos' | 'returns' | 'orders' | 'payments' | 'installments' | 'exchanges' | 'profile';
type Role = 'Super_Admin' | 'Admin' | 'Manager' | 'Finance_Officer' | 'Stock_Clerk' | 'Sales' | 'Purchasor';

function parseRoleFromToken(): Role | null {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role as Role;
  } catch {
    return null;
  }
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('branches');
  const [userRole, setUserRole] = useState<Role | null>(null);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    setUserRole(parseRoleFromToken());
    // Land on dashboard for Manager/Admin, branches for others
    const role = parseRoleFromToken();
    if (role === 'Manager' || role === 'Admin') setCurrentPage('dashboard');
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setUserRole(null);
    setCurrentPage('branches');
  };

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {!isAuthenticated ? (
            <LoginPage onSuccess={handleLoginSuccess} />
          ) : (
            <Layout
              currentPage={currentPage}
              onNavigate={setCurrentPage}
              onLogout={handleLogout}
              userRole={userRole}
            >
              {currentPage === 'dashboard' && <DashboardPage userRole={userRole ?? undefined} />}
              {currentPage === 'branches' && <BranchesPage userRole={userRole ?? undefined} />}
              {currentPage === 'staff' && <StaffPage />}
              {currentPage === 'audit-log' && <AuditLogPage />}
              {currentPage === 'settings' && <SettingsPage userRole={userRole ?? undefined} />}
              {currentPage === 'bank-accounts' && <BankAccountsPage userRole={userRole ?? undefined} />}
              {currentPage === 'locations' && <LocationsPage userRole={userRole ?? undefined} />}
              {currentPage === 'catalog' && <CatalogPage userRole={userRole ?? undefined} />}
              {currentPage === 'inventory' && <InventoryPage userRole={userRole ?? undefined} />}
              {currentPage === 'suppliers' && <SuppliersPage userRole={userRole ?? undefined} />}
              {currentPage === 'procurement' && <ProcurementPage userRole={userRole ?? undefined} />}
              {currentPage === 'customers' && <CustomersPage userRole={userRole ?? undefined} />}
              {currentPage === 'pos' && <POSPage userRole={userRole ?? undefined} />}
              {currentPage === 'returns' && <ReturnsPage userRole={userRole ?? undefined} />}
              {currentPage === 'orders' && <OrdersPage userRole={userRole ?? undefined} />}
              {currentPage === 'payments' && <PaymentsPage userRole={userRole ?? undefined} />}
              {currentPage === 'installments' && <InstallmentsPage userRole={userRole ?? undefined} />}
              {currentPage === 'exchanges' && <ExchangesPage userRole={userRole ?? undefined} />}
              {currentPage === 'profile' && <ProfilePage />}
            </Layout>
          )}
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
