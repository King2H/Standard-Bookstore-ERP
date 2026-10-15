// #23 (M6, step 4): Staff moves to features/. The page offers only what the
// API accepts (roles below one's own, in the branches one manages; account
// actions for Admins; all-branch access for a Super_Admin; location access in
// the branches one manages), pages through every account, offers every open
// branch, checks the create form and the temporary password with the API's
// rules before sending. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BranchListResponseSchema, BranchSchema, CreateStaffRequestSchema, LocationListResponseSchema, MessageResponseSchema,
  ProfileResponseSchema, StaffListResponseSchema, StaffLocationListResponseSchema, StaffSchema,
  type Branch, type ProfileResponse, type Staff,
} from '@bms/shared';
import StaffPage from '../features/staff/pages/StaffPage.js';
import { contract } from './contract.js';

const branch = (id: number, over: Partial<Branch> = {}): Branch => contract(BranchSchema, {
  id, name: `Branch ${String(id).padStart(2, '0')}`, address: `${id} Main St`, contactInfo: {}, operatingHours: {},
  isActive: true, createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

type Held = { branchId: number; role: string; branchName?: string | null };

const member = (id: number, username: string, roles: Held[], over: Partial<Staff> = {}): Staff => contract(StaffSchema, {
  id, username, fullName: `Full ${username}`, isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
  lockedUntil: null, failedLoginAttempts: 0, lastLoginAt: null, passwordChangedAt: null, isAllBranches: false,
  roles: roles.map((r) => ({ branchName: `Branch ${String(r.branchId).padStart(2, '0')}`, ...r })), canManage: true, ...over,
});

function profile(roles: string[], { allBranches = false, branchId = 1, held }: { allBranches?: boolean; branchId?: number; held?: Held[] } = {}): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 500, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: allBranches,
    roles: (held ?? roles.map((role) => ({ branchId, role }))).map((r) => ({ branchName: 'Home', ...r })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: branchId,
    locationAccess: { mode: 'full', locations: [] },
  });
}

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let staff: Staff[];
let branches: Branch[];
let assigned: Record<number, number[]>;

const locationsOf = (branchId: number) => [branchId * 10 + 1, branchId * 10 + 2];

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    const page = Number(u.searchParams.get('page') ?? 1);
    const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 25), 100);
    const paged = <T,>(all: T[]) => ({ items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize, totalPages: Math.ceil(all.length / pageSize) });

    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (method === 'GET' && u.pathname === '/staff') return json(contract(StaffListResponseSchema, paged(staff)));
    if (method === 'GET' && u.pathname === '/branches') {
      const open = u.searchParams.get('isActive') === 'true' ? branches.filter(b => b.isActive) : branches;
      return json(contract(BranchListResponseSchema, paged(open)));
    }
    if (method === 'POST' && u.pathname === '/staff') return json({ staffId: 99 }, 201);
    const staffLoc = u.pathname.match(/^\/staff\/(\d+)\/locations$/);
    if (method === 'GET' && staffLoc) {
      const ids = assigned[Number(staffLoc[1])] ?? [];
      return json(contract(StaffLocationListResponseSchema, {
        items: ids.map((id) => ({ locationId: id, locationName: `Loc ${id}`, branchId: Math.floor(id / 10) })),
        total: ids.length, fallbackMode: ids.length === 0,
      }));
    }
    const loc = u.pathname.match(/^\/branches\/(\d+)\/locations$/);
    if (method === 'GET' && loc) {
      const branchId = Number(loc[1]);
      return json(contract(LocationListResponseSchema, {
        items: locationsOf(branchId).map((id, i) => ({ id, branchId, name: `Loc ${id}`, isDefaultFulfillment: i === 0, createdAt: '2026-10-01T00:00:00.000Z' })),
        total: 2, accessMode: 'full',
      }));
    }
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

/** Lets every answer the page asked for arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><StaffPage /></QueryClientProvider>);
}

const row = async (username: string) => (await screen.findByText(username)).closest('tr')!;
const sent = (method: string, path: string) => calls.find(c => c.method === method && c.path === path);

beforeEach(() => {
  branches = [branch(1), branch(2), branch(3, { isActive: false })];
  staff = [
    member(1, 'boss', [{ branchId: 1, role: 'Admin' }], { canManage: false }),
    member(2, 'clerk', [{ branchId: 1, role: 'Sales' }]),
  ];
  assigned = {};
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Staff: what each role is offered', () => {
  it('gives a Manager role editing only, with roles below Manager, and no account actions', async () => {
    me = profile(['Manager']);
    renderPage();
    expect(within(await row('boss')).queryByTitle('Edit branch & role assignments')).toBeNull();
    const clerk = await row('clerk');
    await settle();
    expect(within(clerk).queryByTitle('Deactivate staff')).toBeNull();
    expect(within(clerk).queryByTitle(/Reset password/)).toBeNull();
    expect(within(clerk).queryByTitle(/all-branch access/)).toBeNull();
    expect(screen.queryByText('+ New Staff')).toBeNull();

    await userEvent.click(within(clerk).getByTitle('Edit branch & role assignments'));
    const roles = within(clerk).getAllByRole('option').map(o => o.textContent);
    expect(roles).toContain('Sales');
    expect(roles).not.toContain('Manager');
  });

  it('creates an account with its roles in one request, offering an Admin no Admin role and no all-branch access', async () => {
    me = profile(['Admin']);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('+ New Staff'));
    expect(screen.queryByText(/All Branches/)).toBeNull();
    const form = screen.getByText('Create Staff Account').closest('form')!;
    const roles = within(form).getAllByRole('option').map(o => o.textContent);
    expect(roles).not.toContain('Admin');
    expect(roles).toContain('Manager');

    await user.type(screen.getByPlaceholderText('e.g. john.doe'), 'new.clerk');
    await user.type(screen.getByPlaceholderText('e.g. John Doe'), 'New Clerk');
    await user.type(screen.getByPlaceholderText('Min 10 chars'), 'Temp#2026pass');
    await user.selectOptions(within(form).getAllByRole('combobox')[0], '1');
    await user.click(screen.getByText('Create Staff'));

    await waitFor(() => expect(sent('POST', '/staff')).toBeDefined());
    const body = sent('POST', '/staff')!.body;
    expect(body).toEqual({ username: 'new.clerk', password: 'Temp#2026pass', fullName: 'New Clerk', roles: [{ branchId: 1, role: 'Sales' }], isAllBranches: false });
    expect(() => CreateStaffRequestSchema.parse(body)).not.toThrow();
  });

  it('offers all-branch access to a Super_Admin', async () => {
    me = profile(['Super_Admin']);
    renderPage();
    expect(within(await row('clerk')).getByTitle('Grant all-branch access')).toBeInTheDocument();
  });

  it('counts any role held: a Sales clerk also made Admin gets the account actions', async () => {
    me = profile(['Sales', 'Admin']);
    renderPage();
    expect(within(await row('clerk')).getByTitle('Deactivate staff')).toBeInTheDocument();
  });
});

describe('Staff: the list and the pickers', () => {
  it('pages through more than 25 staff (was: the rest never shown)', async () => {
    me = profile(['Admin']);
    staff = Array.from({ length: 30 }, (_, i) => member(i + 1, `user${String(i + 1).padStart(2, '0')}`, [{ branchId: 1, role: 'Sales' }]));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Showing 1–25 of 30 staff members')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('user30')).toBeInTheDocument();
    expect(calls.some(c => c.path === '/staff?page=2&pageSize=25')).toBe(true);
  });

  it('offers every open branch to pick, up to the API\'s largest page (was: the first 25)', async () => {
    me = profile(['Admin']);
    branches = Array.from({ length: 30 }, (_, i) => branch(i + 1));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('+ New Staff'));
    const form = screen.getByText('Create Staff Account').closest('form')!;
    expect(await within(form).findByRole('option', { name: 'Branch 30' })).toBeInTheDocument();
    expect(calls.some(c => c.path === '/branches?isActive=true&pageSize=100')).toBe(true);
  });

  it('checks the username and password with the API\'s rules and sends nothing (was: sent, then refused)', async () => {
    me = profile(['Admin']);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('+ New Staff'));
    await user.type(screen.getByPlaceholderText('e.g. john.doe'), 'new clerk');
    await user.type(screen.getByPlaceholderText('e.g. John Doe'), 'New Clerk');
    await user.type(screen.getByPlaceholderText('Min 10 chars'), 'longenough1');
    await user.selectOptions(within(screen.getByText('Create Staff Account').closest('form')!).getAllByRole('combobox')[0], '1');
    await user.click(screen.getByText('Create Staff'));
    expect(await screen.findByText('Letters, digits, dots, underscores and hyphens only')).toBeInTheDocument();
    expect(screen.getByText(/contain upper-case, lower-case, digit and special character/)).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
});

describe('Staff: editing roles', () => {
  it('shows a role in a closed branch under that branch\'s name (was: the first branch\'s)', async () => {
    me = profile(['Super_Admin']);
    staff = [member(2, 'clerk', [{ branchId: 3, role: 'Sales' }])];
    const user = userEvent.setup();
    renderPage();
    const clerk = await row('clerk');
    await user.click(within(clerk).getByTitle('Edit branch & role assignments'));
    const select = within(clerk).getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe('Branch 03');
    await user.click(within(clerk).getByText('Save'));
    await waitFor(() => expect(sent('PUT', '/staff/2/roles')?.body).toEqual([{ branchId: 3, role: 'Sales' }]));
  });

  it('lets a Manager change roles in their own branch only, and sends the others back as they are (was: refused by the API)', async () => {
    me = profile(['Manager'], { branchId: 1 });
    staff = [member(2, 'clerk', [{ branchId: 1, role: 'Sales' }, { branchId: 2, role: 'Sales' }])];
    const user = userEvent.setup();
    renderPage();
    const clerk = await row('clerk');
    await user.click(within(clerk).getByTitle('Edit branch & role assignments'));
    expect(within(clerk).getByTitle('Not yours to change')).toHaveTextContent('Branch 02 · Sales');
    const pickers = within(clerk).getAllByLabelText('Branch');
    expect(pickers).toHaveLength(1);
    expect(within(pickers[0]).getAllByRole('option').map(o => o.textContent)).toEqual(['Branch 01']);

    await user.selectOptions(within(clerk).getByLabelText('Role'), 'Stock_Clerk');
    await user.click(within(clerk).getByText('Save'));
    await waitFor(() => expect(sent('PUT', '/staff/2/roles')?.body).toEqual([
      { branchId: 2, role: 'Sales' }, { branchId: 1, role: 'Stock_Clerk' },
    ]));
  });
});

describe('Staff: location access', () => {
  it('lists each location once for someone with two roles in one branch (was: twice)', async () => {
    me = profile(['Manager']);
    staff = [member(2, 'clerk', [{ branchId: 1, role: 'Sales' }, { branchId: 1, role: 'Stock_Clerk' }])];
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await row('clerk')).getByTitle('Manage location access'));
    expect(await screen.findAllByRole('button', { name: /^Loc 11/ })).toHaveLength(1);
    expect(calls.filter(c => c.path === '/branches/1/locations')).toHaveLength(1);
  });

  it('lets a Manager change locations in their branch only, sending another branch\'s back as they are (was: refused by the API)', async () => {
    me = profile(['Manager'], { branchId: 1 });
    staff = [member(2, 'clerk', [{ branchId: 1, role: 'Sales' }, { branchId: 2, role: 'Sales' }])];
    assigned = { 2: [21] };
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await row('clerk')).getByTitle('Manage location access'));
    expect(await screen.findByRole('button', { name: /^Loc 21/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Loc 22/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^Loc 11/ }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await user.click(screen.getByRole('button', { name: /^Loc 12/ }));
    await user.click(screen.getByRole('button', { name: 'Save Access' }));
    await waitFor(() => expect(sent('PUT', '/staff/2/locations')?.body).toEqual([21, 12]));
  });
});

describe('Staff: resetting a password', () => {
  it('asks for it hidden and checks it with the API\'s rules before sending (was: the browser\'s prompt, in plain text)', async () => {
    me = profile(['Admin']);
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await row('clerk')).getByTitle(/Reset password/));
    const dialog = screen.getByRole('dialog', { name: 'Reset password for clerk' });
    const field = within(dialog).getByLabelText('Temporary password');
    expect(field).toHaveAttribute('type', 'password');

    await user.type(field, 'weakpassword');
    await user.click(within(dialog).getByRole('button', { name: 'Reset Password' }));
    expect(await within(dialog).findByText(/contain upper-case, lower-case, digit and special character/)).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST')).toBe(false);

    await user.clear(field);
    await user.type(field, 'Temp#2026pass');
    await user.click(within(dialog).getByRole('button', { name: 'Reset Password' }));
    await waitFor(() => expect(sent('POST', '/staff/2/reset-password')?.body).toEqual({ temporaryPassword: 'Temp#2026pass' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(prompt).not.toHaveBeenCalled();
  });
});
