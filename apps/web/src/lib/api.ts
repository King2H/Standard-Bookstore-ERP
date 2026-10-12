// Typed API client — all requests go through here
// In production, VITE_API_URL points to the deployed backend (e.g. https://bms-api.onrender.com)
// In development, requests go to /api/v1 (proxied by Vite to localhost:3000)
const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined) ?? ''}/api/v1`;

/** The full URL of an API path, for the few requests that cannot go through `api` (the notification stream). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** A query string from the set values of `params`, with its `?`, or '' when none is set. */
export function toQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

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

// Called whenever the API answers PASSWORD_CHANGE_REQUIRED (#38), so the app
// sends the user to the change-password screen however the request was made.
let _onPasswordChangeRequired: (() => void) | null = null;
export function setPasswordChangeRequiredHandler(fn: (() => void) | null) {
  _onPasswordChangeRequired = fn;
}

// Called whenever the API says the session has ended (#21): signed out
// elsewhere, password changed on another device, reset by an admin, account
// deactivated, or a stolen refresh token used. The app returns to sign-in.
const SESSION_ENDED = new Set(['TOKEN_REVOKED', 'ACCOUNT_INACTIVE']);
let _onSessionEnded: (() => void) | null = null;
export function setSessionEndedHandler(fn: (() => void) | null) {
  _onSessionEnded = fn;
}

/** The headers every API request carries: the session, the branch and, on changes, the CSRF token. */
export function authHeaders(method = 'GET'): Record<string, string> {
  const csrfToken = !SAFE_METHODS.has(method) ? getCsrfToken() : null;
  return {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(currentBranchId ? { 'X-Branch-Id': String(currentBranchId) } : {}),
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  };
}

async function request<T>(method: string, path: string, body?: unknown, as: 'json' | 'blob' = 'json'): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeaders(method) },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'UNKNOWN', message: res.statusText }));
    if (err.error === 'PASSWORD_CHANGE_REQUIRED') _onPasswordChangeRequired?.();
    if (SESSION_ENDED.has(err.error)) {
      // Dropped first, so signing out does not call the API with it again.
      accessToken = null;
      _onSessionEnded?.();
    }
    throw Object.assign(new Error(err.message), { code: err.error, status: res.status, details: err.details });
  }

  // Any successful API call counts as user activity
  _notifyActivity?.();

  return (as === 'blob' ? res.blob() : res.json()) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** A file the API sends (CSV exports). */
  download: (path: string) => request<Blob>('GET', path, undefined, 'blob'),
};

/** Saves a file the API sends under `filename`. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const blob = await api.download(path);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
