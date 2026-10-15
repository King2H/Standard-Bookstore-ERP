import { useLocation, useNavigate } from 'react-router';
import LoginPage from '../features/auth/pages/LoginPage.js';
import Layout from '../components/Layout.js';
import SessionWarning from '../components/SessionWarning.js';
import { AppProviders } from './providers.js';
import { useSession } from './useSession.js';
import { AppRoutes } from './routes.js';
import { isPage, landingPage, pagePath, type Page } from './navigation.js';

export default function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}

/** Sign-in until there is a session; then the layout around the page in the URL. */
function AppShell() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  // Show a spinner while checking the refresh token cookie on app load.
  // This prevents a flash of the login page before the restore check completes.
  if (session.restoring) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Restoring session…</p>
        </div>
      </div>
    );
  }

  if (!session.isAuthenticated) return <LoginPage onSuccess={session.signedIn} />;

  const urlPage = location.pathname.split('/')[1] ?? '';
  const currentPage: Page = isPage(urlPage) ? urlPage : landingPage(session.userRole);
  const handleNavigate = (page: Page, context?: Record<string, string>) => {
    if (session.mustChangePassword && page !== 'profile') return;
    navigate(pagePath(page, context));
  };

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={handleNavigate}
      onLogout={session.signOut}
      userRole={session.userRole}
      userRoles={session.userRoles}
      userPermissions={session.userPermissions}
      activeBranchId={session.activeBranchId}
      onSwitchBranch={session.switchBranch}
    >
      {session.mustChangePassword && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 px-4 py-2 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <span>⚠️</span>
          <span>Your password must be changed before continuing. Please update it in your profile.</span>
        </div>
      )}
      <AppRoutes session={session} onNavigate={handleNavigate} />

      {/* Inactivity warning overlay */}
      <SessionWarning
        secondsLeft={session.warningSeconds}
        onStayLoggedIn={session.stayLoggedIn}
        onLogoutNow={session.signOut}
      />
    </Layout>
  );
}
