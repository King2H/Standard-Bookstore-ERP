// #23 (M6, step 4): Adjust and Transfer move to features/inventory, with the
// page shell. Staff limited to certain locations are offered only those to
// change, and may send a transfer to any location of the branch (#72; owner
// decision 1a); an adjustment follows the branch's negative-stock setting; a
// transfer never asks for more than the source holds; a conflict reads the
// row again; and the search waits for typing to pause. Every mocked answer is
// checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EffectiveConfigResponseSchema, LocationListResponseSchema, ProfileResponseSchema, StockLevelListResponseSchema,
  StockLevelSchema, StockMovementListResponseSchema, TransferStockResponseSchema, type ProfileResponse, type StockLevel,
} from '@bms/shared';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';
const SHOP = { id: 1, name: 'Shop Floor', isDefaultFulfillment: true };
const BACK = { id: 2, name: 'Back Store', isDefaultFulfillment: false };
const ANNEX = { id: 3, name: 'Annex', isDefaultFulfillment: false };

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
  branchId: 1, quantity, reserved: 0, available: quantity, reorderPoint: 5, averageCost: 10, damaged: 0, damagedValue: 0, version, isLowStock: false, updatedAt: CREATED,
});

const location = (l: typeof SHOP) => ({ ...l, branchId: 1, createdAt: CREATED });

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
    if (u.pathname === '/branches/1/locations') {
      // As the API answers: staff limited to some locations get only theirs, unless they ask for all.
      const restricted = me.locationAccess.mode === 'restricted';
      const items = restricted && u.searchParams.get('all') !== 'true' ? me.locationAccess.locations : [SHOP, BACK, ANNEX];
      return json(contract(LocationListResponseSchema, { items: items.map(location), total: items.length, accessMode: me.locationAccess.mode }));
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
      if (u.pathname === '/inventory/transfer') {
        const sent = body as { quantity: number; fromVersion: number };
        return json(contract(TransferStockResponseSchema, {
          from: level(1, 'Animal Farm', SHOP, sent.fromVersion + 1, 12 - sent.quantity),
          to: level(1, 'Animal Farm', BACK, 1, sent.quantity),
        }));
      }
      const sent = body as { delta: number; version: number };
      return json(contract(StockLevelSchema, level(1, 'Animal Farm', SHOP, sent.version + 1, 12 + sent.delta)));
    }
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function openTab(name: 'Adjust' | 'Transfer') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Animal Farm');
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/[^\w ]/g, '').trim() === name)!);
  return user;
}

/** Searches the picker and chooses a book at a location. */
async function choose(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.type(screen.getByPlaceholderText('Search books…'), title.slice(0, 6));
  await user.click((await screen.findByText(title)).closest('button')!);
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const pickerOf = () => screen.getByPlaceholderText('Search books…').closest('div')!.parentElement!;

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Stock_Clerk']);
  allowNegative = false;
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Inventory: Adjust', () => {
  it('offers staff limited to some locations only those (was: every location, which the API refused)', async () => {
    me = profile(['Stock_Clerk'], [SHOP]);
    const user = await openTab('Adjust');
    await user.type(screen.getByPlaceholderText('Search books…'), 'Anima');
    await screen.findAllByText('Animal Farm');
    await settle();
    expect(within(pickerOf()).queryByText('Burmese Days')).toBeNull();
  });

  it('blocks taking stock below zero when the branch does not allow it (was: sent, then refused)', async () => {
    const user = await openTab('Adjust');
    await choose(user, 'Animal Farm');
    await user.selectOptions(screen.getByRole('combobox'), 'loss');
    await user.type(screen.getByPlaceholderText('0'), '15');
    expect(screen.getByText(/below zero/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record Adjustment/ })).toBeDisabled();
  });

  it('allows it when the branch does', async () => {
    allowNegative = true;
    const user = await openTab('Adjust');
    await choose(user, 'Animal Farm');
    await user.selectOptions(screen.getByRole('combobox'), 'loss');
    await user.type(screen.getByPlaceholderText('0'), '15');
    await user.click(screen.getByRole('button', { name: /Record Adjustment/ }));
    await waitFor(() => expect(posted('/inventory/adjust')).toHaveLength(1));
    expect(posted('/inventory/adjust')[0]).toEqual({ bookId: 1, locationId: 1, delta: -15, reasonCode: 'loss', version: 3 });
  });

  it('checks the notes are at most 500 characters before sending (was: sent and refused)', async () => {
    const user = await openTab('Adjust');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('0'), '2');
    await user.click(screen.getByPlaceholderText('Additional context…'));
    await user.paste('x'.repeat(501));
    await user.click(screen.getByRole('button', { name: /Record Adjustment/ }));
    expect(await screen.findByText('Notes can be at most 500 characters')).toBeInTheDocument();
    await settle();
    expect(posted('/inventory/adjust')).toEqual([]);
  });

  it('reads the row again after a conflict, so a retry is based on it (was: kept stale, refused every time)', async () => {
    refusals = [{ status: 409, error: 'VERSION_CONFLICT', message: 'Inventory was modified by another operation.' }];
    const user = await openTab('Adjust');
    await choose(user, 'Animal Farm');
    await user.type(screen.getByPlaceholderText('0'), '2');
    await user.click(screen.getByRole('button', { name: /Record Adjustment/ }));
    await waitFor(() => expect(screen.getByText(/Current qty/)).toHaveTextContent('Current qty: 20'));
    await user.click(screen.getByRole('button', { name: /Record Adjustment/ }));
    await waitFor(() => expect(posted('/inventory/adjust')).toHaveLength(2));
    expect(posted('/inventory/adjust').map((b) => b.version)).toEqual([3, 7]);
  });

  it('waits for typing to pause before searching (was: on every key)', async () => {
    const user = await openTab('Adjust');
    await user.type(screen.getByPlaceholderText('Search books…'), 'Animal');
    await screen.findAllByText('Animal Farm');
    await settle();
    const searches = calls.filter((c) => c.method === 'GET' && new URL(c.path, 'http://x').searchParams.get('q'));
    expect(searches.map((c) => new URL(c.path, 'http://x').searchParams.get('q'))).toEqual(['Animal']);
  });
});

describe('Inventory: Transfer', () => {
  it('lets staff limited to some locations send to any location of the branch (was: only their own)', async () => {
    me = profile(['Stock_Clerk'], [SHOP]);
    const user = await openTab('Transfer');
    await choose(user, 'Animal Farm');
    await waitFor(() => expect([...(screen.getByRole('combobox') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', '2', '3']));
  });

  it('moves stock and says where it went', async () => {
    const user = await openTab('Transfer');
    await choose(user, 'Animal Farm');
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).options.length).toBe(3));
    await user.selectOptions(screen.getByRole('combobox'), '2');
    await user.type(screen.getByPlaceholderText('Units to transfer'), '4');
    await user.click(screen.getByRole('button', { name: /Transfer Stock/ }));
    await waitFor(() => expect(posted('/inventory/transfer')).toHaveLength(1));
    expect(posted('/inventory/transfer')[0]).toEqual({ bookId: 1, fromLocationId: 1, toLocationId: 2, quantity: 4, fromVersion: 3 });
    expect(await screen.findByText('Transferred 4 units. From: 8 remaining. To: 4 now.')).toBeInTheDocument();
  });

  it('does not ask for more than the source holds (was: sent, then refused)', async () => {
    const user = await openTab('Transfer');
    await choose(user, 'Animal Farm');
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).options.length).toBe(3));
    await user.selectOptions(screen.getByRole('combobox'), '2');
    await user.type(screen.getByPlaceholderText('Units to transfer'), '13');
    expect(screen.getByText(/Exceeds available stock \(12\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Transfer Stock/ })).toBeDisabled();
  });
});
