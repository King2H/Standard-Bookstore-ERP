// #23 (M6, step 4): Profile and sign-in move to features/. The profile shows
// every role held in the session branch, refuses a new password equal to the
// current one before sending it (the API refuses it too: a forced change could
// otherwise keep an admin's temporary password), and every field is labelled.
// Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AccessTokenResponseSchema, ChangePasswordRequestSchema, LoginRequestSchema, MessageResponseSchema, PreLoginResponseSchema,
  ProfileResponseSchema, type PreLoginResponse, type ProfileResponse,
} from '@bms/shared';
import ProfilePage from '../features/account/pages/ProfilePage.js';
import LoginPage from '../features/auth/pages/LoginPage.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

function profile(currentRoles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 7, username: 'abebe', fullName: 'Abebe Kebede', isActive: true, createdAt: '2026-10-01T00:00:00.000Z',
    mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: currentRoles.map((role) => ({ branchId: 1, branchName: 'Main Branch', role })),
    currentRole: currentRoles[0], currentRoles, currentBranchId: 1,
    locationAccess: { mode: 'full', locations: [] },
  });
}

const token = (branchId: number) => `x.${btoa(JSON.stringify({ branchId, permissions: ['CREATE_SALE'] }))}.y`;

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let preLogin: { status: number; body: PreLoginResponse | { error: string; message: string } };

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (path === '/auth/pre-login') return json(preLogin.body, preLogin.status);
    if (path === '/auth/login') {
      return json(contract(AccessTokenResponseSchema, { accessToken: token(body.branchId), expiresIn: 900, mustChangePassword: true, csrfToken: 'c' }));
    }
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

const sent = (method: string, path: string) => calls.find(c => c.method === method && c.path === path);

beforeEach(() => {
  localStorage.setItem('bms-theme', 'light'); // jsdom has no matchMedia
  setAccessToken('x');
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Profile', () => {
  function renderProfile(onPasswordChanged = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ProfilePage onPasswordChanged={onPasswordChanged} /></QueryClientProvider>);
    return onPasswordChanged;
  }

  it('shows every role held in the session branch (was: only the first)', async () => {
    me = profile(['Sales', 'Manager']);
    renderProfile();
    expect(await screen.findByText('Abebe Kebede')).toBeInTheDocument();
    // Each role shows in the header and in the assignments.
    expect(screen.getAllByText('Sales')).toHaveLength(2);
    expect(screen.getAllByText('Manager')).toHaveLength(2);
  });

  it('refuses a new password equal to the current one and sends nothing (was: sent, and a forced change kept the temporary password)', async () => {
    me = profile(['Sales']);
    const user = userEvent.setup();
    renderProfile();
    await user.click(await screen.findByRole('button', { name: 'Change Password' }));
    await user.type(screen.getByPlaceholderText('Enter your current password'), 'Temp#2026pass');
    await user.type(screen.getByPlaceholderText('Min 10 chars, upper, lower, digit, special'), 'Temp#2026pass');
    await user.type(screen.getByPlaceholderText('Re-enter new password'), 'Temp#2026pass');
    await user.click(screen.getByRole('button', { name: 'Update Password' }));
    expect(await screen.findByText('Must differ from your current password')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('changes the password with a body the API contract accepts', async () => {
    me = profile(['Sales']);
    const user = userEvent.setup();
    const onPasswordChanged = renderProfile();
    await user.click(await screen.findByRole('button', { name: 'Change Password' }));
    await user.type(screen.getByPlaceholderText('Enter your current password'), 'Temp#2026pass');
    await user.type(screen.getByPlaceholderText('Min 10 chars, upper, lower, digit, special'), 'Mine#2026pass');
    await user.type(screen.getByPlaceholderText('Re-enter new password'), 'Mine#2026pass');
    await user.click(screen.getByRole('button', { name: 'Update Password' }));
    await waitFor(() => expect(onPasswordChanged).toHaveBeenCalled());
    const body = sent('PUT', '/staff/me/password')!.body;
    expect(body).toEqual({ currentPassword: 'Temp#2026pass', newPassword: 'Mine#2026pass' });
    expect(() => ChangePasswordRequestSchema.parse(body)).not.toThrow();
  });

  it('labels its password fields (was: labels not linked to them)', async () => {
    me = profile(['Sales']);
    const user = userEvent.setup();
    renderProfile();
    await user.click(await screen.findByRole('button', { name: 'Change Password' }));
    for (const label of [/^Current Password/, /^New Password/, /^Confirm New Password/]) {
      expect(screen.getByLabelText(label)).toHaveAttribute('type', 'password');
    }
  });
});

describe('Sign-in', () => {
  const access = (branchId: number, branchName: string) => ({ branchId, branchName, roles: ['Sales'], isAllBranches: false });

  it('labels its fields (was: labels not linked to them)', async () => {
    render(<LoginPage onSuccess={vi.fn()} />);
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByText('Bookstore ERP')).toBeInTheDocument();
    expect(screen.queryByText(/Phase 0/)).not.toBeInTheDocument();
  });

  it('signs in to the branch picked, with a body the API contract accepts', async () => {
    preLogin = { status: 200, body: contract(PreLoginResponseSchema, {
      staffId: 7, branches: [access(1, 'Main Branch'), access(2, 'Bole Branch')], isAllBranches: false, autoSelectBranchId: null,
    }) };
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage onSuccess={onSuccess} />);
    await user.type(screen.getByPlaceholderText('Enter your username'), 'abebe');
    await user.type(screen.getByPlaceholderText('Enter your password'), 'Mine#2026pass');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: /Bole Branch/ }));
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ mustChangePassword: true, permissions: ['CREATE_SALE'] }));
    const body = sent('POST', '/auth/login')!.body;
    expect(body).toEqual({ username: 'abebe', password: 'Mine#2026pass', branchId: 2 });
    expect(() => LoginRequestSchema.parse(body)).not.toThrow();
  });

  it('says why a sign-in was refused', async () => {
    preLogin = { status: 401, body: { error: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } };
    const user = userEvent.setup();
    render(<LoginPage onSuccess={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Enter your username'), 'abebe');
    await user.type(screen.getByPlaceholderText('Enter your password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
    expect(sent('POST', '/auth/login')).toBeUndefined();
  });
});
