import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, setPasswordChangeRequiredHandler } from '../lib/api.js';
import { restoreSession } from '../lib/auth.js';

// #38: the client follows the server. Any PASSWORD_CHANGE_REQUIRED answer
// sends the user to the change-password screen, and a page reload keeps the
// requirement instead of dropping it.

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

// A syntactically valid JWT whose payload carries a branch and permissions.
const token = `x.${btoa(JSON.stringify({ branchId: 1, permissions: ['CREATE_SALE'] }))}.y`;

afterEach(() => {
  vi.unstubAllGlobals();
  setPasswordChangeRequiredHandler(null);
});

describe('forced password change in the client', () => {
  it('calls the handler when the API answers PASSWORD_CHANGE_REQUIRED, and still rejects', async () => {
    const handler = vi.fn();
    setPasswordChangeRequiredHandler(handler);
    respond(403, { error: 'PASSWORD_CHANGE_REQUIRED', message: 'Your password must be changed before continuing.' });

    await expect(api.get('/orders')).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED', status: 403 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not call it for other errors', async () => {
    const handler = vi.fn();
    setPasswordChangeRequiredHandler(handler);
    respond(403, { error: 'PERMISSION_DENIED', message: 'Not allowed' });

    await expect(api.get('/orders')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the requirement when the session is restored after a reload (was: always false)', async () => {
    respond(200, { accessToken: token, expiresIn: 900, mustChangePassword: true });
    expect(await restoreSession()).toMatchObject({ restored: true, mustChangePassword: true });

    respond(200, { accessToken: token, expiresIn: 900, mustChangePassword: false });
    expect(await restoreSession()).toMatchObject({ restored: true, mustChangePassword: false });
  });
});
