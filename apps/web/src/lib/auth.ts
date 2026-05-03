import { api, getAccessToken, setAccessToken, setCurrentBranchId, setCsrfToken } from './api.js';

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  csrfToken?: string;
  mustChangePassword?: boolean;
}

// ── Parse JWT payload fields ──────────────────────────────────────────────────

function parseBranchIdFromToken(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.branchId === 'number' ? payload.branchId : null;
  } catch {
    return null;
  }
}

function parsePermissionsFromToken(token: string): string[] {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return Array.isArray(payload.permissions) ? payload.permissions as string[] : [];
  } catch {
    return [];
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string,
  branchId: number,
): Promise<{ mustChangePassword: boolean; permissions: string[] }> {
  const res = await api.post<LoginResponse>('/auth/login', { username, password, branchId });
  setAccessToken(res.accessToken);
  setCurrentBranchId(branchId);
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  scheduleRefresh(res.expiresIn);
  const permissions = parsePermissionsFromToken(res.accessToken);
  return { mustChangePassword: res.mustChangePassword ?? false, permissions };
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  cancelRefresh();
  // Only call the server logout if we actually have a token — avoids a noisy
  // 401 when logout is called before any session is established.
  if (getAccessToken()) {
    await api.post('/auth/logout').catch(() => {});
  }
  setAccessToken(null);
  setCurrentBranchId(null);
  setCsrfToken(null);
}

// ── Restore session on page refresh ──────────────────────────────────────────
//
// The refresh token lives in an HTTP-only cookie — it survives page reloads.
// On mount, attempt a silent token refresh:
//   - Success → user stays logged in, no login page shown
//   - Failure (no cookie / expired) → show login page
//
// This is the ONLY place that decides whether to show the login page on load.

export async function restoreSession(): Promise<{
  restored: boolean;
  mustChangePassword: boolean;
  permissions: string[];
}> {
  try {
    const res = await api.post<LoginResponse>('/auth/refresh');
    setAccessToken(res.accessToken);
    const branchId = parseBranchIdFromToken(res.accessToken);
    if (branchId) setCurrentBranchId(branchId);
    if (res.csrfToken) setCsrfToken(res.csrfToken);
    scheduleRefresh(res.expiresIn);
    const permissions = parsePermissionsFromToken(res.accessToken);
    return { restored: true, mustChangePassword: false, permissions };
  } catch {
    // 401 = no valid cookie, 500 = server error — either way, show login
    setAccessToken(null);
    setCurrentBranchId(null);
    return { restored: false, mustChangePassword: false, permissions: [] };
  }
}

// ── Switch Branch ─────────────────────────────────────────────────────────────
// Issues a new access token for a different branch without re-login.

export async function switchBranch(
  branchId: number,
): Promise<{ permissions: string[] }> {
  const res = await api.post<LoginResponse>('/auth/switch-branch', { branchId });
  setAccessToken(res.accessToken);
  setCurrentBranchId(branchId);
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  scheduleRefresh(res.expiresIn);
  const permissions = parsePermissionsFromToken(res.accessToken);
  return { permissions };
}

// ── Token refresh scheduler ───────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(expiresInSeconds: number) {
  cancelRefresh();
  // Refresh 60 seconds before expiry to keep the session alive
  const delay = Math.max((expiresInSeconds - 60) * 1000, 0);
  refreshTimer = setTimeout(async () => {
    try {
      const res = await api.post<LoginResponse>('/auth/refresh');
      setAccessToken(res.accessToken);
      const branchId = parseBranchIdFromToken(res.accessToken);
      if (branchId) setCurrentBranchId(branchId);
      if (res.csrfToken) setCsrfToken(res.csrfToken);
      scheduleRefresh(res.expiresIn);
    } catch {
      // Silent refresh failed — clear tokens.
      // The next API call will get a 401 and the app will handle it.
      setAccessToken(null);
      setCurrentBranchId(null);
      setCsrfToken(null);
    }
  }, delay);
}
