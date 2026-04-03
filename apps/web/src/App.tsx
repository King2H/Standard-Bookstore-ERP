import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LoginPage from './pages/LoginPage.js';
import BranchesPage from './pages/BranchesPage.js';
import StaffPage from './pages/StaffPage.js';
import AuditLogPage from './pages/AuditLogPage.js';
import SettingsPage from './pages/SettingsPage.js';
import BankAccountsPage from './pages/BankAccountsPage.js';
import LocationsPage from './pages/LocationsPage.js';
import ProfilePage from './pages/ProfilePage.js';
import { ToastProvider } from './components/Toast.js';
import { ThemeProvider } from './lib/theme.js';
import Layout from './components/Layout.js';
import { getAccessToken } from './lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

type Page = 'branches' | 'staff' | 'audit-log' | 'settings' | 'bank-accounts' | 'locations' | 'profile';
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
              {currentPage === 'branches' && <BranchesPage userRole={userRole ?? undefined} />}
              {currentPage === 'staff' && <StaffPage />}
              {currentPage === 'audit-log' && <AuditLogPage />}
              {currentPage === 'settings' && <SettingsPage userRole={userRole ?? undefined} />}
              {currentPage === 'bank-accounts' && <BankAccountsPage userRole={userRole ?? undefined} />}
              {currentPage === 'locations' && <LocationsPage userRole={userRole ?? undefined} />}
              {currentPage === 'profile' && <ProfilePage />}
            </Layout>
          )}
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
