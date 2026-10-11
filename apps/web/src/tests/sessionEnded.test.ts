import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, getAccessToken, setAccessToken, setSessionEndedHandler } from '../lib/api.js';

// #21: the server ends sessions at once (logout elsewhere, a password change on
// another device, an admin reset, deactivation, a reused refresh token). Any
// request that hears so takes the user back to sign-in.

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionEndedHandler(null);
});

describe('a session ended on the server', () => {
  it.each(['TOKEN_REVOKED', 'ACCOUNT_INACTIVE'])('calls the handler on %s, and still rejects', async (code) => {
    setAccessToken('x.e30.y');
    // Signing out with the dropped token must not call the API again.
    const handler = vi.fn(() => expect(getAccessToken()).toBeNull());
    setSessionEndedHandler(handler);
    respond(401, { error: code, message: 'This session has ended; sign in again' });

    await expect(api.get('/orders')).rejects.toMatchObject({ code, status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });

  it('does not call it for an expired access token, which the refresh renews', async () => {
    const handler = vi.fn();
    setSessionEndedHandler(handler);
    respond(401, { error: 'TOKEN_EXPIRED', message: 'Access token has expired' });

    await expect(api.get('/orders')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(handler).not.toHaveBeenCalled();
  });
});
