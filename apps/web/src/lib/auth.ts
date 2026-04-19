import { api, setAccessToken, setCurrentBranchId, setCsrfToken } from './api.js';

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  csrfToken?: string;
}

export async function login(username: string, password: string, branchId: number): Promise<void> {
  const res = await api.post<LoginResponse>('/auth/login', { username, password, branchId });
  setAccessToken(res.accessToken);
  setCurrentBranchId(branchId);
  if (res.csrfToken) setCsrfToken(res.csrfToken);
  scheduleRefresh(res.expiresIn);
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout').catch(() => {});
  setAccessToken(null);
  setCurrentBranchId(null);
  setCsrfToken(null);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(expiresInSeconds: number) {
  if (refreshTimer) clearTimeout(refreshTimer);
  // Refresh 60 seconds before expiry
  const delay = Math.max((expiresInSeconds - 60) * 1000, 0);
  refreshTimer = setTimeout(async () => {
    try {
      const res = await api.post<LoginResponse>('/auth/refresh');
      setAccessToken(res.accessToken);
      if (res.csrfToken) setCsrfToken(res.csrfToken);
      scheduleRefresh(res.expiresIn);
    } catch {
      setAccessToken(null);
      setCsrfToken(null);
    }
  }, delay);
}
