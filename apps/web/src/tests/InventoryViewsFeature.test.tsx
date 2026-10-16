// #23 (M6, step 4): the Inventory views move to features/inventory: Stock
// Levels, History and Low Stock. Stock changes are offered only to the roles
// the API lets move stock (any role held counts); a row's quick "+ In" and
// "− Out" open that tab with the row chosen; a reorder point is checked before
// sending; History filters by the reasons movements are recorded with; and the
// search waits for typing to pause. Every mocked answer is checked against
// its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ProfileResponseSchema, StockLevelListResponseSchema, StockLevelSchema, StockMovementListResponseSchema,
  type ProfileResponse, type StockLevel,
} from '@bms/shared';
import InventoryPage from '../pages/InventoryPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

/** The permissions the API gives each role (lib/permissions.ts), as far as these tests need them. */
const PERMISSIONS: Record<string, string[]> = {
  Admin: ['CREATE_SALE', 'MANAGE_INVENTORY', 'VIEW_REPORTS', 'MANAGE_STAFF', 'MANAGE_BRANCH'],
  Stock_Clerk: ['MANAGE_INVENTORY'],
  Purchasor: ['MANAGE_INVENTORY', 'VIEW_REPORTS'],
};

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const level = (bookId: number, title: string): StockLevel => contract(StockLevelSchema, {
  bookId, bookTitle: title, bookIsbn: `978030640615${bookId}`, bookIsActive: true, locationId: 1, locationName: 'Shop Floor',
  branchId: 1, quantity: 12, reserved: 0, available: 12, reorderPoint: 5, version: 3, isLowStock: false, updatedAt: CREATED,
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
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
    const list = <T,>(items: T[]) => ({ items, total: items.length, page: 1, totalPages: 1 });
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/inventory/low-stock') return json(contract(StockLevelListResponseSchema, list([])));
    if (u.pathname === '/inventory/history') return json(contract(StockMovementListResponseSchema, list([])));
    if (u.pathname === '/inventory') return json(contract(StockLevelListResponseSchema, list([level(1, 'Animal Farm'), level(2, 'Burmese Days')])));
    if (method === 'PUT') return json(contract(StockLevelSchema, level(1, 'Animal Farm')));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** The page as the app shows it: the first role held, and the permissions of every role held. */
async function renderPage() {
  const perms = [...new Set(me.currentRoles.flatMap((r) => PERMISSIONS[r] ?? []))];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage userRole={me.currentRole} userPermissions={perms} /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Animal Farm');
  await settle();
}

const rowOf = (title: string) => screen.getByText(title).closest('tr')! as HTMLElement;
const tabNames = () => screen.getAllByRole('button').map((b) => b.textContent ?? '').filter((t) => /Stock In|Stock Out|Adjust|Transfer/.test(t));
const asked = (prefix: string) => calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix)).map((c) => new URL(c.path, 'http://x').searchParams);

beforeEach(() => {
  setAccessToken('x');
  me = profile(['Admin']);
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Inventory: who may change stock', () => {
  it('offers a Purchasor no stock changes, which the API refuses (was: Stock In, Stock Out, Adjust and Transfer)', async () => {
    me = profile(['Purchasor']);
    await renderPage();
    expect(tabNames()).toEqual([]);
  });

  it('offers a Stock Clerk a row\'s "+ In", which opens Stock In with that row chosen (was: hidden, and the row ignored)', async () => {
    me = profile(['Stock_Clerk']);
    await renderPage();
    await userEvent.setup().click(within(rowOf('Burmese Days')).getByTitle('Stock In'));
    expect(await screen.findByText(/Current qty/)).toBeInTheDocument();
    expect(screen.getAllByText('Burmese Days').length).toBeGreaterThan(0);
  });

  it('opens Stock Out with the row chosen from its "− Out" (was: an empty form)', async () => {
    await renderPage();
    await userEvent.setup().click(within(rowOf('Animal Farm')).getByTitle('Stock Out'));
    expect(await screen.findByText(/Available:/)).toBeInTheDocument();
  });

  it('lets a row\'s actions brighten on hover (was: the row had no `group`, so they stayed faded)', async () => {
    await renderPage();
    expect(rowOf('Animal Farm').className).toMatch(/\bgroup\b/);
  });
});

describe('Inventory: reorder points', () => {
  it('checks the reorder point before sending (was: an empty box was sent and refused)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(within(rowOf('Animal Farm')).getByText('⚙'));
    await user.clear(rowOf('Animal Farm').querySelector('input[type=number]')!);
    await user.click(within(rowOf('Animal Farm')).getByText('✓'));
    expect(await screen.findByText('Enter a whole number of copies, 0 or more')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('saves a reorder point', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(within(rowOf('Animal Farm')).getByText('⚙'));
    const box = rowOf('Animal Farm').querySelector('input[type=number]')!;
    await user.clear(box);
    await user.type(box, '8');
    await user.click(within(rowOf('Animal Farm')).getByText('✓'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ bookId: 1, locationId: 1, reorderPoint: 8 }));
  });
});

describe('Inventory: history and search', () => {
  it('filters History by the reasons movements are recorded with (was: also "Stock Out", never recorded)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: /History/ }));
    const reasons = screen.getAllByRole('combobox').find((c) => within(c).queryByRole('option', { name: 'All Reasons' }))!;
    expect(within(reasons).getAllByRole('option').map((o) => (o as HTMLOptionElement).value).filter(Boolean))
      .toEqual(['correction', 'damage', 'initial', 'loss', 'return', 'sale', 'stock_in', 'transfer_in', 'transfer_out']);
  });

  it('asks once typing pauses (was: a request for every key)', async () => {
    await renderPage();
    await userEvent.setup().type(screen.getByPlaceholderText('Search books…'), 'Animal');
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(asked('/inventory?').filter((p) => p.has('q')).map((p) => p.get('q'))).toEqual(['Animal']);
  });
});
