// Typed API client — all requests go through here
// In production, VITE_API_URL points to the deployed backend (e.g. https://bms-api.onrender.com)
// In development, requests go to /api (proxied by Vite to localhost:3000)
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)
  ? `${import.meta.env.VITE_API_URL as string}/api`
  : '/api';

let accessToken: string | null = null;
let currentBranchId: number | null = null;
let csrfTokenMemory: string | null = null; // In-memory fallback for CSRF token

// Lazy import to avoid circular dependency (session.ts imports api.ts indirectly)
let _notifyActivity: (() => void) | null = null;
export function setActivityNotifier(fn: () => void) {
  _notifyActivity = fn;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function setCurrentBranchId(branchId: number | null) {
  currentBranchId = branchId;
}

export function getCurrentBranchId() {
  return currentBranchId;
}

/** Store CSRF token in memory (called after login/refresh). */
export function setCsrfToken(token: string | null) {
  csrfTokenMemory = token;
}

/**
 * Get CSRF token — tries in-memory first (most reliable),
 * then falls back to reading the cookie (works when path='/' is set).
 */
function getCsrfToken(): string | null {
  if (csrfTokenMemory) return csrfTokenMemory;
  // Cookie fallback
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const csrfToken = !SAFE_METHODS.has(method) ? getCsrfToken() : null;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(currentBranchId ? { 'X-Branch-Id': String(currentBranchId) } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'UNKNOWN', message: res.statusText }));
    throw Object.assign(new Error(err.message), { code: err.error, status: res.status, details: err.details });
  }

  // Any successful API call counts as user activity
  _notifyActivity?.();

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
