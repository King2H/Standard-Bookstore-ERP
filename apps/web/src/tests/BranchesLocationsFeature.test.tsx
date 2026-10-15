// #23 (M6, step 4): Branches and Locations move to features/. The screens now
// offer only what the API accepts: opening, closing, creating and deleting a
// branch belong to Super_Admin or an Admin with access to all branches, and a
// branch's locations are changed from that branch unless the account has
// access to all branches. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BranchListResponseSchema, BranchSchema, CreateBranchRequestSchema, LocationListResponseSchema, MessageResponseSchema,
  ProfileResponseSchema, type Branch, type ProfileResponse,
} from '@bms/shared';
import BranchesPage from '../features/branches/pages/BranchesPage.js';
import LocationsPage from '../features/locations/pages/LocationsPage.js';
import { contract } from './contract.js';

const branch = (id: number, over: Partial<Branch> = {}): Branch => contract(BranchSchema, {
  id, name: `Branch ${String(id).padStart(2, '0')}`, address: `${id} Main St`, contactInfo: {}, operatingHours: {},
  isActive: true, createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

function profile(roles: string[], isAllBranches: boolean, currentBranchId = 3): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches,
    roles: roles.map((role) => ({ branchId: currentBranchId, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId,
    locationAccess: { mode: 'full', locations: [] },
  });
}

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let branches: Branch[];
let me: ProfileResponse;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (method === 'GET' && u.pathname === '/branches') {
      const page = Number(u.searchParams.get('page') ?? 1);
      const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 25), 100);
      const open = u.searchParams.get('isActive') === 'true' ? branches.filter(b => b.isActive) : branches;
      const items = open.slice((page - 1) * pageSize, page * pageSize);
      return json(contract(BranchListResponseSchema, { items, total: open.length, page, pageSize, totalPages: Math.ceil(open.length / pageSize) }));
    }
    if (method === 'POST' && u.pathname === '/branches') {
      const created = branch(99, { ...CreateBranchRequestSchema.parse(body), name: body.name });
      return json(created, 201);
    }
    const loc = u.pathname.match(/^\/branches\/(\d+)\/locations$/);
    if (method === 'GET' && loc) {
      const branchId = Number(loc[1]);
      return json(contract(LocationListResponseSchema, {
        items: [{ id: branchId * 10, branchId, name: `Floor of ${branchId}`, isDefaultFulfillment: true, createdAt: '2026-10-01T00:00:00.000Z' }],
        total: 1, accessMode: 'full',
      }));
    }
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

/** Lets every answer the page asked for arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

function renderPage(page: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{page}</QueryClientProvider>);
}

beforeEach(() => {
  branches = [branch(1), branch(3), branch(4, { isActive: false })];
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Branches', () => {
  it('offers head-office actions to an Admin with access to all branches', async () => {
    me = profile(['Admin'], true);
    renderPage(<BranchesPage />);
    expect(await screen.findByRole('button', { name: '+ New Branch' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Deactivate' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(3);
  });

  it('offers them to Super_Admin', async () => {
    me = profile(['Super_Admin'], false);
    renderPage(<BranchesPage />);
    expect(await screen.findByRole('button', { name: '+ New Branch' })).toBeInTheDocument();
  });

  for (const [who, roles, all] of [
    ['a Manager (was: "+ New Branch" shown)', ['Manager'], false],
    ['an Admin of one branch (was: Delete shown)', ['Admin'], false],
    ['Sales (was: Deactivate shown)', ['Sales'], false],
    ['a Manager with access to all branches', ['Manager'], true],
  ] as const) {
    it(`offers no open, close, create or delete to ${who}`, async () => {
      me = profile([...roles], all);
      renderPage(<BranchesPage />);
      expect(await screen.findByText('Branch 01')).toBeInTheDocument();
      await settle();
      for (const name of ['+ New Branch', 'Deactivate', 'Reactivate', 'Delete']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
    });
  }

  it('counts any role held: a Manager also made Admin, with access to all branches, gets them', async () => {
    me = profile(['Manager', 'Admin'], true);
    renderPage(<BranchesPage />);
    expect(await screen.findByRole('button', { name: '+ New Branch' })).toBeInTheDocument();
  });

  it('pages through more than 25 branches (was: the rest never shown)', async () => {
    me = profile(['Admin'], true);
    branches = Array.from({ length: 30 }, (_, i) => branch(i + 1));
    const user = userEvent.setup();
    renderPage(<BranchesPage />);
    expect(await screen.findByText('Showing 1–25 of 30 branches')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Branch 30')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/branches?page=2&pageSize=25')).toBe(true);
  });

  it('creates a branch with a body the API contract accepts', async () => {
    me = profile(['Admin'], true);
    const user = userEvent.setup();
    renderPage(<BranchesPage />);
    await user.click(await screen.findByRole('button', { name: '+ New Branch' }));
    await user.type(screen.getByLabelText(/^Name/), 'Bole Branch');
    await user.type(screen.getByLabelText(/^Address/), 'Bole Road, Addis Ababa');
    await user.type(screen.getByLabelText('Email'), 'bole@store.example');
    await user.click(screen.getByRole('button', { name: 'Create Branch' }));

    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/branches')).toBe(true));
    const body = calls.find(c => c.method === 'POST' && c.path === '/branches')!.body;
    expect(body).toEqual({ name: 'Bole Branch', address: 'Bole Road, Addis Ababa', contactInfo: { phone: '', email: 'bole@store.example' } });
    expect(() => CreateBranchRequestSchema.parse(body)).not.toThrow();
  });

  it('says what is missing and sends nothing', async () => {
    me = profile(['Admin'], true);
    const user = userEvent.setup();
    renderPage(<BranchesPage />);
    await user.click(await screen.findByRole('button', { name: '+ New Branch' }));
    await user.click(screen.getByRole('button', { name: 'Create Branch' }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Address is required')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('closes a branch', async () => {
    me = profile(['Admin'], true);
    const user = userEvent.setup();
    renderPage(<BranchesPage />);
    const row = (await screen.findByText('Branch 03')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/branches/3/deactivate')).toBe(true));
  });
});

describe('Locations', () => {
  it('opens on the session\'s branch (was: the first branch in the list)', async () => {
    me = profile(['Manager'], false, 3);
    renderPage(<LocationsPage />);
    expect(await screen.findByText('Floor of 3')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/branches/1/locations')).toBe(false);
  });

  it('lets a Manager change their own branch\'s locations, and only look at another\'s (was: buttons the API refused)', async () => {
    me = profile(['Manager'], false, 3);
    const user = userEvent.setup();
    renderPage(<LocationsPage />);
    await screen.findByText('Floor of 3');
    expect(screen.getByRole('button', { name: '+ New Location' })).toBeInTheDocument();
    expect(screen.getByTitle('Delete')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), '1');
    expect(await screen.findByText('Floor of 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New Location' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
  });

  it('lets an account with access to all branches change any branch', async () => {
    me = profile(['Manager'], true, 3);
    const user = userEvent.setup();
    renderPage(<LocationsPage />);
    await screen.findByText('Floor of 3');
    await user.selectOptions(screen.getByRole('combobox'), '1');
    expect(await screen.findByText('Floor of 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New Location' })).toBeInTheDocument();
  });

  it('offers Sales no changes', async () => {
    me = profile(['Sales'], false, 3);
    renderPage(<LocationsPage />);
    await screen.findByText('Floor of 3');
    expect(screen.queryByRole('button', { name: '+ New Location' })).not.toBeInTheDocument();
  });

  it('lists the open branches to pick from, up to the API\'s largest page (was: the first 25)', async () => {
    me = profile(['Admin'], true, 3);
    renderPage(<LocationsPage />);
    await screen.findByText('Floor of 3');
    expect(calls.some(c => c.path === '/branches?isActive=true&pageSize=100')).toBe(true);
    expect(screen.queryByRole('option', { name: 'Branch 04' })).not.toBeInTheDocument();
  });

  it('adds a location to the branch shown', async () => {
    me = profile(['Manager'], false, 3);
    const user = userEvent.setup();
    renderPage(<LocationsPage />);
    await screen.findByText('Floor of 3');
    await user.click(screen.getByRole('button', { name: '+ New Location' }));
    await user.type(screen.getByPlaceholderText(/Main Floor/), 'Back Room');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')).toMatchObject({ path: '/branches/3/locations', body: { name: 'Back Room' } }));
  });
});
