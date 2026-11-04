// #228 (#225 P1, K3; owner decisions 1a–4a, 2026-11-04): the welcome banner
// names the shop from its settings (was: one shop's name hard-coded for every
// shop), and every printed slip carries the shop's header: its name, the
// branch with its address and phone, and the TIN when set. Every mocked answer
// is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ProfileResponseSchema, ShopIdentitySchema, type ProfileResponse, type ShopIdentity } from '@bms/shared';
import WelcomeBanner from '../components/WelcomeBanner.js';
import { PrintSlip } from '../components/PrintSlip.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const identity = (over: Partial<ShopIdentity> = {}): ShopIdentity => contract(ShopIdentitySchema, {
  name: 'Kuraz Books', motto: 'Read more', tin: '0012345678',
  branch: { id: 1, name: 'Piassa Branch', address: 'Piassa, Addis Ababa', phone: '+251111000000' },
  ...over,
});

let me: ProfileResponse;
let shop: ShopIdentity;

beforeEach(() => {
  setAccessToken('x');
  try { sessionStorage.clear(); } catch { /* ignore */ }
  me = profile(['Sales']);
  shop = identity();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url.replace(/^.*\/api\/v1/, ''), 'http://x').pathname;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (path === '/config/shop') return json(contract(ShopIdentitySchema, shop));
    return json({});
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

describe('Welcome banner (#228, 3a)', () => {
  it("welcomes to the shop by its own name and motto (was: one shop's name for every shop)", async () => {
    renderWith(<WelcomeBanner />);
    expect(await screen.findByText('Welcome to Kuraz Books')).toBeInTheDocument();
    expect(screen.getByText('Read more')).toBeInTheDocument();
    expect(screen.queryByText(/Bakos/)).not.toBeInTheDocument();
  });

  it('says only "Welcome" with no name set, and shows Super_Admin where to set it', async () => {
    shop = identity({ name: '', motto: '' });
    me = profile(['Super_Admin']);
    renderWith(<WelcomeBanner />);
    expect(await screen.findByRole('link', { name: /Set your shop's name/ })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
  });

  it('shows no settings link to anyone else', async () => {
    shop = identity({ name: '', motto: '' });
    renderWith(<WelcomeBanner />);
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    await screen.findByText('Welcome');
    expect(screen.queryByRole('link', { name: /Set your shop's name/ })).not.toBeInTheDocument();
  });
});

describe('Printed slips (#228, 2a)', () => {
  it("carry the shop's header: name, branch, address, phone and TIN (was: a title only)", async () => {
    renderWith(<PrintSlip title="Order ORD-1" onClose={() => {}}><p>lines</p></PrintSlip>);
    const slip = screen.getByRole('dialog', { name: 'Order ORD-1' });
    expect(await screen.findByText('Kuraz Books')).toBeInTheDocument();
    expect(slip).toHaveTextContent('Piassa Branch');
    expect(slip).toHaveTextContent('Piassa, Addis Ababa');
    expect(slip).toHaveTextContent('+251111000000');
    expect(slip).toHaveTextContent('TIN 0012345678');
  });

  it('leave out what is not set', async () => {
    shop = identity({ name: '', tin: '', branch: { id: 1, name: 'Main Branch', address: '', phone: '' } });
    renderWith(<PrintSlip title="Order ORD-1" onClose={() => {}}><p>lines</p></PrintSlip>);
    expect(await screen.findByText('Main Branch')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('TIN');
  });
});
