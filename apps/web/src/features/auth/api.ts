import type { PreLoginRequest, PreLoginResponse } from '@bms/shared';
import { apiUrl } from '../../lib/api.js';

export type PreLoginResult = { ok: true; body: PreLoginResponse } | { ok: false; message: string | undefined };

/**
 * Checks the password and lists the branches to sign in to. Not through `api`:
 * a refused sign-in is an answer here, not a session that ended.
 */
export async function preLogin(body: PreLoginRequest): Promise<PreLoginResult> {
  const res = await fetch(apiUrl('/auth/pre-login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  const json = await res.json();
  return res.ok ? { ok: true, body: json as PreLoginResponse } : { ok: false, message: (json as { message?: string }).message };
}
