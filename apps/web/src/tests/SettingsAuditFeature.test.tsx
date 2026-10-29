// #23 (M6, step 4): Settings and the audit log move to features/. Settings
// offers only what the API accepts (any role held counts; a branch's settings
// from that branch unless with access to all branches; removing an override
// for Super_Admin and Admin) and checks a value with the API's rules before
// sending it. The audit log filters by every kind of record the API writes and
// refreshes every 30 seconds while in view. Every mocked answer is checked
// against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuditLogListResponseSchema, BranchConfigListResponseSchema, BranchListResponseSchema, BranchSchema, ConfigEntrySchema,
  MessageResponseSchema, ProfileResponseSchema, SystemConfigListResponseSchema, type Branch, type ProfileResponse,
} from '@bms/shared';
import SettingsPage from '../features/settings/pages/SettingsPage.js';
import AuditLogPage from '../features/auditLog/pages/AuditLogPage.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const branch = (id: number, over: Partial<Branch> = {}): Branch => contract(BranchSchema, {
  id, name: `Branch ${String(id).padStart(2, '0')}`, address: `${id} Main St`, contactInfo: {}, operatingHours: {},
  isActive: true, createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

function profile(roles: string[], isAllBranches = false, currentBranchId = 1): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches,
    roles: roles.map((role) => ({ branchId: currentBranchId, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId, locationAccess: { mode: 'full', locations: [] },
  });
}

const entry = (key: string, value: unknown) => ({ key, value, updatedBy: 1, updatedAt: '2026-10-01T00:00:00.000Z' });
const SYSTEM = [
  entry('base_currency', 'ETB'), entry('max_line_discount_pct', { Sales: 10, Manager: 25 }),
  entry('default_discount_type', 'Normal'), entry('return_window_days', 7),
  entry('require_cash_session', false), entry('cash_variance_limit', 50),
];

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let branches: Branch[];

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
    if (u.pathname === '/config/system' && method === 'GET') return json(contract(SystemConfigListResponseSchema, { items: SYSTEM, total: SYSTEM.length }));
    if (u.pathname === '/branches') {
      const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 25), 100);
      const open = u.searchParams.get('isActive') === 'true' ? branches.filter(b => b.isActive) : branches;
      return json(contract(BranchListResponseSchema, { items: open.slice(0, pageSize), total: open.length, page: 1, pageSize, totalPages: Math.ceil(open.length / pageSize) }));
    }
    const branchConfig = u.pathname.match(/^\/config\/branches\/(\d+)$/);
    if (branchConfig && method === 'GET') {
      return json(contract(BranchConfigListResponseSchema, { items: [
        { ...entry('base_currency', 'ETB'), source: 'system' }, { ...entry('return_window_days', 14), source: 'branch' },
      ], total: 2 }));
    }
    if (u.pathname === '/audit-logs') {
      return json(contract(AuditLogListResponseSchema, { items: [{
        id: '1', staffId: 1, staffUsername: 'admin', staffRole: 'Admin', action: 'UPDATE', entityType: 'system_config',
        entityId: 'return_window_days', branchId: null, branchName: null, meta: 'plain note', createdAt: '2026-10-01T00:00:00.000Z',
      }], total: 1, page: 1, pageSize: 25, totalPages: 1 }));
    }
    if (method === 'PUT') return json(contract(ConfigEntrySchema, entry('x', body.value)));
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

/** Lets every answer the page asked for arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

function renderPage(page: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{page}</QueryClientProvider>);
}

const settingRow = async (label: string) => (await screen.findByText(label)).closest('div.flex.items-start')! as HTMLElement;
const sent = (method: string, path: string) => calls.find(c => c.method === method && c.path === path);

beforeEach(() => {
  setAccessToken('x');
  branches = [branch(1), branch(2), branch(3, { isActive: false })];
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Settings', () => {
  it('lists the cash session settings on a Cash tab (#171, 4a; was: not offered)', async () => {
    me = profile(['Admin']);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Cash' }));
    expect(await settingRow('Require Cash Session')).toBeInTheDocument();
    expect(await settingRow('Cash Variance Limit')).toBeInTheDocument();
  });

  it('counts any role held: a Manager also made Super_Admin edits system defaults (was: read-only)', async () => {
    me = profile(['Manager', 'Super_Admin']);
    renderPage(<SettingsPage />);
    expect(within(await settingRow('Base Currency')).getByTitle('Edit')).toBeInTheDocument();
  });

  it('refuses mistyped JSON and sends nothing (was: sent as text, then read as a 0% limit for every role)', async () => {
    me = profile(['Super_Admin'], true);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Discounts' }));
    const row = await settingRow('Max Line Discount % (per role)');
    await user.click(within(row).getByTitle('Edit'));
    const box = within(row).getByRole('textbox');
    await user.clear(box);
    await user.type(box, '{{"Sales": 10');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('Not valid JSON');

    await user.clear(box);
    await user.type(box, '{{"Sales": 150}');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('Must give each role 0 to 100');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('refuses an empty number and sends nothing (was: sent as null)', async () => {
    me = profile(['Super_Admin'], true);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Returns' }));
    const row = await settingRow('Return Window (days)');
    await user.click(within(row).getByTitle('Edit'));
    await user.clear(within(row).getByRole('spinbutton'));
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('Enter a number');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('saves a discount preset with a value the API takes', async () => {
    me = profile(['Super_Admin'], true);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Discounts' }));
    const row = await settingRow('Default Discount Type');
    await user.click(within(row).getByTitle('Edit'));
    await user.selectOptions(within(row).getByRole('combobox'), 'Merchant');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/config/system/default_discount_type')?.body).toEqual({ value: 'Merchant' }));
  });

  it('offers a Manager only their own open branch (was: every branch, others refused by the API)', async () => {
    me = profile(['Manager'], false, 1);
    renderPage(<SettingsPage />);
    await screen.findByText('Base Currency');
    await settle();
    const picker = screen.getByRole('combobox');
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Select a branch...', 'Branch 01']);
    expect(calls.some(c => c.path === '/branches?isActive=true&pageSize=100')).toBe(true);
  });

  it('offers every open branch with access to all branches', async () => {
    me = profile(['Admin'], true, 1);
    renderPage(<SettingsPage />);
    await screen.findByText('Base Currency');
    await settle();
    expect(within(screen.getByRole('combobox')).getAllByRole('option').map(o => o.textContent))
      .toEqual(['Select a branch...', 'Branch 01', 'Branch 02']);
  });

  it('lets a Manager override a branch setting but not remove an override (was: offered, refused by the API)', async () => {
    me = profile(['Manager'], false, 1);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await screen.findByText('Base Currency');
    await settle();
    await user.selectOptions(screen.getByRole('combobox'), '1');
    await user.click(screen.getByRole('button', { name: 'Returns' }));
    const overrides = (await screen.findByText('Branch Overrides')).closest('div.bg-white')! as HTMLElement;
    const row = (await within(overrides).findByText('Return Window (days)')).closest('div.flex.items-start')! as HTMLElement;
    expect(within(row).getByTitle('Override')).toBeInTheDocument();
    expect(within(row).queryByTitle('Remove override')).not.toBeInTheDocument();
  });

  it('offers no branch override of the currency, which holds for every branch (was: offered, so a branch showed another currency)', async () => {
    me = profile(['Super_Admin'], true, 1);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await screen.findByText('Base Currency');
    await settle();
    await user.selectOptions(screen.getByRole('combobox'), '1');
    const overrides = (await screen.findByText('Branch Overrides')).closest('div.bg-white')! as HTMLElement;
    await within(overrides).findByText('No settings in this category');
    expect(within(overrides).queryByText('Base Currency')).not.toBeInTheDocument();
  });

  it('refuses a currency that is not a three-letter ISO 4217 code and sends nothing', async () => {
    me = profile(['Super_Admin'], true);
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    const row = await settingRow('Base Currency');
    await user.click(within(row).getByTitle('Edit'));
    const box = within(row).getByRole('textbox');
    await user.clear(box);
    await user.type(box, 'Birr');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('three-letter ISO 4217 code');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });
});

describe('Audit log', () => {
  it('filters by every kind of record the API writes (was: 8 of them)', async () => {
    me = profile(['Admin'], true);
    const user = userEvent.setup();
    renderPage(<AuditLogPage />);
    const filter = await screen.findByRole('combobox');
    for (const type of ['system_config', 'branch_config', 'order', 'return', 'exchange', 'receivable', 'bank_account']) {
      expect(within(filter).getByRole('option', { name: type })).toBeInTheDocument();
    }
    // Stock changes by hand, and costs set (#163; was: none of the inventory records).
    for (const type of ['inventory', 'inventory_cost', 'inventory_reorder', 'inventory_stock_in', 'inventory_stock_out']) {
      expect(within(filter).getByRole('option', { name: type })).toBeInTheDocument();
    }
    await user.selectOptions(filter, 'system_config');
    await waitFor(() => expect(calls.some(c => c.path === '/audit-logs?page=1&pageSize=25&entityType=system_config')).toBe(true));
  });

  it('shows details that are not named values', async () => {
    me = profile(['Admin'], true);
    renderPage(<AuditLogPage />);
    expect(await screen.findByText('value: "plain note"')).toBeInTheDocument();
  });

  it('refreshes every 30 seconds while in view, not every 3 (was: every 3, even in a background tab)', async () => {
    me = profile(['Admin'], true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage(<AuditLogPage />);
      await screen.findByText('system_config');
      const asked = () => calls.filter(c => c.path.startsWith('/audit-logs')).length;
      const first = asked();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(asked()).toBe(first);
      await act(() => vi.advanceTimersByTimeAsync(21_000));
      expect(asked()).toBe(first + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
