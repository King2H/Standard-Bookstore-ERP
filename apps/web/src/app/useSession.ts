import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { getAccessToken, setPasswordChangeRequiredHandler, setSessionEndedHandler } from '../lib/api.js';
import { logout as doLogout, restoreSession, switchBranch as doSwitchBranch } from '../lib/auth.js';
import { startInactivityTimer, stopInactivityTimer } from '../lib/session.js';
import { isPage, landingPage, pagePath } from './navigation.js';
import { queryClient } from './providers.js';

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

/**
 * The signed-in account and everything that changes it: sign-in, restoring
 * the session on load, switching branch, the forced password change, the
 * inactivity timeout and sign-out. Pages where the session sends the user
 * (landing, profile, sign-in) are URLs, so this also navigates.
 */
export function useSession() {
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

  function applyRoleLanding(role: Role | null) {
    navigateRef.current(pagePath(landingPage(role)), { replace: true });
  }

  const passwordChanged = () => {
    if (!mustChangePassword) return;
    setMustChangePassword(false);
    applyRoleLanding(userRole);
    queryClient.invalidateQueries();
  };

  const signedIn = (opts?: { mustChangePassword?: boolean; permissions?: string[] }) => {
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

  const signOut = async () => {
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
  const switchBranch = async (branchId: number) => {
    try {
      const { permissions } = await doSwitchBranch(branchId);
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

  return {
    restoring: sessionRestoring,
    isAuthenticated,
    userRole,
    userRoles,
    userPermissions,
    activeBranchId,
    mustChangePassword,
    warningSeconds,
    stayLoggedIn: () => setWarningSeconds(0),
    signedIn,
    signOut,
    switchBranch,
    passwordChanged,
  };
}

export type Session = ReturnType<typeof useSession>;
