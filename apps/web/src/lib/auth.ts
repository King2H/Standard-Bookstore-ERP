import { api, setAccessToken, setCurrentBranchId } from './api.js';

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

export async function login(username: string, password: string, branchId: number): Promise<void> {
  const res = await api.post<LoginResponse>('/auth/login', { username, password, branchId });
  setAccessToken(res.accessToken);
  setCurrentBranchId(branchId);
  scheduleRefresh(res.expiresIn);
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout').catch(() => {});
  setAccessToken(null);
  setCurrentBranchId(null);
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
      scheduleRefresh(res.expiresIn);
    } catch {
      setAccessToken(null);
    }
  }, delay);
}
