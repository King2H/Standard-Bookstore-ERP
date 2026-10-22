// #23 (M6, step 4): Stock In and Stock Out move to features/inventory. A
// manual stock-in names no purchase order (owner decision 1a) and sends the
// reference types the API accepts; a manual stock-out names only a manual
// removal (2a) and may go below zero when the shop allows it (4a); staff
// limited to certain locations are offered only those; a conflict reads the
// row again; and the search waits for typing to pause. Every mocked answer
// is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EffectiveConfigResponseSchema, ProfileResponseSchema, StockLevelListResponseSchema, StockLevelSchema,
  StockMovementListResponseSchema, type ProfileResponse, type StockLevel,
} from '@bms/shared';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';
const SHOP = { id: 1, name: 'Shop Floor', isDefaultFulfillment: true };
const BACK = { id: 2, name: 'Back Store', isDefaultFulfillment: false };

function profile(roles: string[], restrictedTo?: (typeof SHOP)[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1,
    locationAccess: restrictedTo ? { mode: 'restricted', locations: restrictedTo } : { mode: 'full', locations: [] },
  });
}

const level = (bookId: number, title: string, at = SHOP, version = 3, quantity = 12): StockLevel => contract(StockLevelSchema, {
  bookId, bookTitle: title, bookIsbn: `978030640615${bookId}`, bookIsActive: true, locationId: at.id, locationName: at.name,
  branchId: 1, quantity, reserved: 0, available: quantity, reorderPoint: 5, averageCost: 10, version, isLowStock: false, updatedAt: CREATED,
});

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let allowNegative: boolean;
/** The answers to the next stock changes, in order; then a success. */
let refusals: { status: number; error: string; message: string }[];

function stubApi() {
  calls = [];
  refusals = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    const list = <T,>(items: T[]) => ({ items, total: items.length, page: 1, totalPages: 1 });
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/effective') {
      return json(contract(EffectiveConfigResponseSchema, { items: [{ key: 'allow_negative_stock', value: allowNegative, source: 'system' }] }));
    }
    if (u.pathname === '/inventory/low-stock') return json(contract(StockLevelListResponseSchema, list([])));
    if (u.pathname === '/inventory/history') return json(contract(StockMovementListResponseSchema, list([])));
    if (u.pathname === '/inventory' && u.searchParams.get('bookId')) {
      return json(contract(StockLevelListResponseSchema, list([level(1, 'Animal Farm', SHOP, 7, 20)])));
    }
    if (u.pathname === '/inventory') {
      return json(contract(StockLevelListResponseSchema, list([level(1, 'Animal Farm'), level(2, 'Burmese Days', BACK)])));
    }
    if (method === 'POST') {
      const refusal = refusals.shift();
      if (refusal) return json({ error: refusal.error, message: refusal.message }, refusal.status);
      const sent = body as { quantity: number; version: number };
      const change = u.pathname.endsWith('stock-in') ? sent.quantity : -sent.quantity;
      return json(contract(StockLevelSchema, level(1, 'Animal Farm', SHOP, sent.version + 1, 12 + change)));
    }
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function openTab(name: 'Stock In' | 'Stock Out') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Animal Farm');
  await settle();
  const user = userEvent.setup();
  const tab = screen.getAllByRole('button').find((b) => b.textContent?.replace(/[^\w ]/g, '').trim() === name)!;
  await user.click(tab);
  return user;
}

/** Searches the picker and chooses a book at a location. */
async function choose(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.type(screen.getByPlaceholderText('Search books…'), title.slice(0, 6));
  await user.click((await screen.findByText(title)).closest('button')!);
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const optionValues = () => [...(screen.getAllByRole('combobox')[0] as HTMLSelectElement).options].map((o) => o.value);

beforeEach(() => {
  setAccessToken('x');
  me = profile(['Stock_Clerk']);
  allowNegative = false;
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Inventory: Stock In', () => {
  it('names no purchase order, which Procurement receives (was: offered, counting the order twice)', async () => {
    await openTab('Stock In');
    expect(optionValues()).toEqual(['', 'return', 'manual', 'initial_stock']);
  });

  it('records opening stock as the API names it (was: opening_stock, always refused)', async () => {
    const user = await openTab('Stock In');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('Units received'), '4');
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'initial_stock');
    await user.type(screen.getByLabelText(/Unit Cost/), '12.50');
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    await waitFor(() => expect(posted('/inventory/stock-in')).toHaveLength(1));
    expect(posted('/inventory/stock-in')[0]).toEqual({ bookId: 1, locationId: 1, quantity: 4, unitCost: '12.50', version: 3, referenceType: 'initial_stock' });
    expect(await screen.findByText('Stock in recorded. New quantity: 16')).toBeInTheDocument();
  });

  it('asks what one copy cost before sending, except for a customer\'s return (#163; was: never asked, so the stock was valued at 0)', async () => {
    const user = await openTab('Stock In');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('Units received'), '4');
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    expect(await screen.findByText('Enter what one copy cost: stock is valued at its cost')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Unit Cost/), '0');
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    expect(await screen.findByText('A unit cost is an amount above 0, e.g. 12.50')).toBeInTheDocument();
    await settle();
    expect(posted('/inventory/stock-in')).toEqual([]);

    await user.clear(screen.getByLabelText(/Unit Cost/));
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'return');
    expect(screen.getByLabelText(/Unit Cost/)).toHaveAttribute('placeholder', 'Left empty: the book\'s last known cost');
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    await waitFor(() => expect(posted('/inventory/stock-in')).toHaveLength(1));
    expect(posted('/inventory/stock-in')[0]).toEqual({ bookId: 1, locationId: 1, quantity: 4, version: 3, referenceType: 'return' });
  });

  it('checks a reference ID is a number before sending (was: sent as null and refused)', async () => {
    const user = await openTab('Stock In');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('Units received'), '4');
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'return');
    await user.type(screen.getByPlaceholderText('Reference number'), 'RCPT-9');
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    expect(await screen.findByText('A reference ID is a whole number')).toBeInTheDocument();
    await settle();
    expect(posted('/inventory/stock-in')).toEqual([]);
  });

  it('reads the row again after a conflict, so a retry is based on it (was: kept stale, refused every time)', async () => {
    refusals = [{ status: 409, error: 'VERSION_CONFLICT', message: 'Inventory was modified by another operation.' }];
    const user = await openTab('Stock In');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('Units received'), '2');
    await user.type(screen.getByLabelText(/Unit Cost/), '5');
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    await waitFor(() => expect(screen.getByText(/Current qty/)).toHaveTextContent('Current qty: 20'));
    await user.click(screen.getByRole('button', { name: /Record Stock In/ }));
    await waitFor(() => expect(posted('/inventory/stock-in')).toHaveLength(2));
    expect(posted('/inventory/stock-in').map((b) => b.version)).toEqual([3, 7]);
  });

  it('waits for typing to pause before searching (was: on every key)', async () => {
    const user = await openTab('Stock In');
    await user.type(screen.getByPlaceholderText('Search books…'), 'Animal');
    await screen.findAllByText('Animal Farm');
    await settle();
    const searches = calls.filter((c) => c.method === 'GET' && new URL(c.path, 'http://x').searchParams.get('q'));
    expect(searches.map((c) => new URL(c.path, 'http://x').searchParams.get('q'))).toEqual(['Animal']);
  });
});

describe('Inventory: Stock Out', () => {
  it('names only a manual removal (was: Sale, Order, and a Damage the API refuses)', async () => {
    await openTab('Stock Out');
    expect(optionValues()).toEqual(['', 'manual']);
  });

  it('lets stock go below zero when the shop allows negative stock (was: always blocked)', async () => {
    allowNegative = true;
    const user = await openTab('Stock Out');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('Units to remove'), '15');
    await user.click(screen.getByRole('button', { name: /Record Stock Out/ }));
    await waitFor(() => expect(posted('/inventory/stock-out')).toHaveLength(1));
    expect(posted('/inventory/stock-out')[0]).toMatchObject({ quantity: 15, version: 3 });
  });

  it('still blocks it when the shop does not', async () => {
    const user = await openTab('Stock Out');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('Units to remove'), '15');
    expect(screen.getByText(/Exceeds available stock/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record Stock Out/ })).toBeDisabled();
  });
});

describe('Inventory: location limits', () => {
  it('offers staff limited to some locations only those (was: every location, which the API refused)', async () => {
    me = profile(['Stock_Clerk'], [SHOP]);
    const user = await openTab('Stock In');
    await user.type(screen.getByPlaceholderText('Search books…'), 'Anima');
    await screen.findAllByText('Animal Farm');
    await settle();
    const picker = screen.getByPlaceholderText('Search books…').closest('div')!.parentElement!;
    expect(within(picker).queryByText('Burmese Days')).toBeNull();
    expect(within(picker).getByText('Animal Farm')).toBeInTheDocument();
  });

  it('does not choose a row at another location from its quick "+ In" (was: chosen, then refused)', async () => {
    me = profile(['Stock_Clerk'], [SHOP]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage /></ToastProvider></QueryClientProvider>);
    const row = (await screen.findByText('Burmese Days')).closest('tr')!;
    await settle();
    await userEvent.setup().click(within(row).getByTitle('Stock In'));
    expect(await screen.findByText(/Select a book and location from the left panel/)).toBeInTheDocument();
    expect(screen.queryByText(/Current qty/)).toBeNull();
  });
});
