// Typed API client — all requests go through here

let accessToken: string | null = null;
let currentBranchId: number | null = null;

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

/** Read the csrf-token cookie set by the server after login. */
function getCsrfToken(): string | null {
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

  const res = await fetch(`/api${path}`, {
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

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
