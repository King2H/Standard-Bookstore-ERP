import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LoginPage from './pages/LoginPage.js';
import BranchesPage from './pages/BranchesPage.js';
import StaffPage from './pages/StaffPage.js';
import AuditLogPage from './pages/AuditLogPage.js';
import { ToastProvider } from './components/Toast.js';
import { logout } from './lib/auth.js';
import { getAccessToken } from './lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1 },
  },
});

type Page = 'branches' | 'staff' | 'audit-log';
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

// Role-based nav visibility per requirements.md §2 RBAC matrix
const NAV_ACCESS: Record<string, Role[]> = {
  branches: ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'],
  staff:    ['Super_Admin', 'Admin', 'Manager'],
  'audit-log': ['Super_Admin', 'Admin'],
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('branches');
  const [userRole, setUserRole] = useState<Role | null>(null);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    setUserRole(parseRoleFromToken());
  };

  const canAccess = (page: string) =>
    userRole ? (NAV_ACCESS[page] ?? []).includes(userRole) : false;

  if (!isAuthenticated) {
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <LoginPage onSuccess={handleLoginSuccess} />
        </ToastProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <div className="min-h-screen bg-gray-50">
          {/* Nav */}
          <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="font-bold text-gray-900">BMS</span>
              {userRole && (
                <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-medium">
                  {userRole}
                </span>
              )}
            </div>
            <div className="flex items-center gap-6">
              {canAccess('branches') && (
                <button
                  onClick={() => setCurrentPage('branches')}
                  className={`text-sm ${currentPage === 'branches' ? 'text-blue-600 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Branches
                </button>
              )}
              {canAccess('staff') && (
                <button
                  onClick={() => setCurrentPage('staff')}
                  className={`text-sm ${currentPage === 'staff' ? 'text-blue-600 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Staff
                </button>
              )}
              {canAccess('audit-log') && (
                <button
                  onClick={() => setCurrentPage('audit-log')}
                  className={`text-sm ${currentPage === 'audit-log' ? 'text-blue-600 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Audit Log
                </button>
              )}
              <button
                onClick={async () => {
                  await logout();
                  setIsAuthenticated(false);
                  setUserRole(null);
                  setCurrentPage('branches');
                }}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Sign Out
              </button>
            </div>
          </nav>

          {/* Content — redirect to branches if current page not accessible */}
          {currentPage === 'branches' && canAccess('branches') && <BranchesPage userRole={userRole ?? undefined} />}
          {currentPage === 'staff' && canAccess('staff') && <StaffPage />}
          {currentPage === 'audit-log' && canAccess('audit-log') && <AuditLogPage />}
          {!canAccess(currentPage) && (
            <div className="p-6 text-center text-gray-500 text-sm">
              You do not have permission to view this page.
            </div>
          )}
        </div>
      </ToastProvider>
    </QueryClientProvider>
  );
}
