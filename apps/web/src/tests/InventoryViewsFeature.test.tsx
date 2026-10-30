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
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const level = (bookId: number, title: string, averageCost = 10, damaged = 0, damagedValue = 0): StockLevel => contract(StockLevelSchema, {
  bookId, bookTitle: title, bookIsbn: `978030640615${bookId}`, bookIsActive: true, locationId: 1, locationName: 'Shop Floor',
  branchId: 1, quantity: 12, reserved: 0, available: 12, reorderPoint: 5, averageCost, damaged, damagedValue, version: 3, isLowStock: false, updatedAt: CREATED,
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
    if (u.pathname === '/inventory') {
      return json(contract(StockLevelListResponseSchema, list([level(1, 'Animal Farm', 10, 3, 12), level(2, 'Burmese Days', 0)])));
    }
    if (u.pathname.startsWith('/inventory/damaged/')) return json(contract(StockLevelSchema, level(1, 'Animal Farm', 10, 2, 8)));
    if (method === 'PUT') return json(contract(StockLevelSchema, level(1, 'Animal Farm')));
    if (u.pathname === '/inventory/revalue') return json(contract(StockLevelSchema, level(2, 'Burmese Days', 11.25)));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** The page as the app shows it; who may do what comes from the signed-in account. */
async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage /></ToastProvider></QueryClientProvider>);
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

describe('Inventory: stock cost (#163)', () => {
  it('marks copies with no cost, and offers Revalue on every row with copies to an Admin or Manager (was: only while the cost was 0)', async () => {
    await renderPage();
    expect(within(rowOf('Burmese Days')).getByTitle('No cost: revalue')).toHaveTextContent('No cost');
    expect(within(rowOf('Animal Farm')).queryByText('No cost')).toBeNull();
    expect(within(rowOf('Animal Farm')).getByTitle('Revalue')).toBeInTheDocument();
    expect(within(rowOf('Burmese Days')).getByTitle('Revalue')).toBeInTheDocument();
  });

  it('offers a Stock Clerk no Revalue, which the API refuses', async () => {
    me = profile(['Stock_Clerk']);
    await renderPage();
    expect(within(rowOf('Burmese Days')).queryByTitle('Revalue')).toBeNull();
    expect(within(rowOf('Burmese Days')).queryByText('No cost')).toBeNull();
  });

  it('asks the new cost and its reason in the app\'s dialog, checked before sending', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(within(rowOf('Burmese Days')).getByTitle('No cost: revalue'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('have no cost, so they add nothing to the inventory value');
    await user.click(within(dialog).getByRole('button', { name: 'Revalue' }));
    expect(await within(dialog).findByText('Enter an amount above 0, e.g. 12.50')).toBeInTheDocument();
    expect(within(dialog).getByText('A reason is required')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/inventory/revalue')).toBe(false);

    await user.type(within(dialog).getByLabelText(/New cost of one copy/), '11.25');
    expect(dialog).toHaveTextContent('New value: ETB 135.00');
    await user.type(within(dialog).getByLabelText(/Where does this cost come from/), 'Supplier invoice 77');
    await user.click(within(dialog).getByRole('button', { name: 'Revalue' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/inventory/revalue')?.body)
      .toEqual({ bookId: 2, locationId: 1, unitCost: '11.25', reason: 'Supplier invoice 77', version: 3 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a priced row\'s value and refuses its own cost before sending', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(within(rowOf('Animal Farm')).getByTitle('Revalue'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('valued at ETB 10.00 each, ETB 120.00 in all');
    await user.type(within(dialog).getByLabelText(/New cost of one copy/), '10');
    await user.type(within(dialog).getByLabelText(/Where does this cost come from/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Revalue' }));
    expect(await within(dialog).findByText('The copies already have this cost')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/inventory/revalue')).toBe(false);
  });
});

describe('Inventory: damaged copies (#168)', () => {
  it('shows each row\'s damaged copies, counted apart (was: not shown)', async () => {
    await renderPage();
    expect(screen.getByRole('columnheader', { name: 'Damaged' })).toBeInTheDocument();
    expect(within(rowOf('Animal Farm')).getByRole('button', { name: /3 damaged/ })).toBeInTheDocument();
    expect(within(rowOf('Burmese Days')).queryByRole('button', { name: /damaged/ })).not.toBeInTheDocument();
  });

  it('writes damaged copies off with a reason, checked before sending, showing the loss (was: no way out)', async () => {
    const user = userEvent.setup();
    me = profile(['Stock_Clerk']);
    await renderPage();
    await user.click(within(rowOf('Animal Farm')).getByRole('button', { name: /3 damaged/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/kept apart at .*12\.00/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Write off' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.clear(within(dialog).getByLabelText('Copies'));
    await user.type(within(dialog).getByLabelText('Copies'), '4');
    expect(await within(dialog).findByText('At most 3')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Copies'));
    await user.type(within(dialog).getByLabelText('Copies'), '1');
    expect(within(dialog).getByText(/Loss: .*4\.00/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Reason'), 'Water damage');
    await user.click(within(dialog).getByRole('button', { name: 'Write off' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const sent = calls.find((c) => c.method === 'POST');
    expect(sent?.path).toBe('/inventory/damaged/write-off');
    expect(sent?.body).toEqual({ bookId: 1, locationId: 1, quantity: 1, reason: 'Water damage', version: 3 });
  });

  it('puts repaired copies back for sale (was: no way out)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(within(rowOf('Animal Farm')).getByRole('button', { name: /3 damaged/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText(/Repaired/));
    await user.type(within(dialog).getByLabelText('Reason'), 'Cover reglued');
    await user.click(within(dialog).getByRole('button', { name: 'Back for sale' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/inventory/damaged/repair');
  });

  it('offers a Purchasor the count but no action, which the API refuses', async () => {
    me = profile(['Purchasor']);
    await renderPage();
    expect(within(rowOf('Animal Farm')).queryByRole('button', { name: /damaged/ })).not.toBeInTheDocument();
    expect(within(rowOf('Animal Farm')).getByText('3')).toBeInTheDocument();
  });
});

describe('Inventory: history and search', () => {
  it('filters History by the reasons movements are recorded with (was: also "Stock Out", never recorded)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: /History/ }));
    const reasons = screen.getAllByRole('combobox').find((c) => within(c).queryByRole('option', { name: 'All Reasons' }))!;
    expect(within(reasons).getAllByRole('option').map((o) => (o as HTMLOptionElement).value).filter(Boolean))
      .toEqual(['correction', 'count', 'damage', 'damage_repaired', 'damage_write_off', 'initial', 'loss', 'return', 'revaluation', 'sale', 'stock_in', 'transfer_in', 'transfer_out', 'transfer_returned']);
  });

  it('asks once typing pauses (was: a request for every key)', async () => {
    await renderPage();
    await userEvent.setup().type(screen.getByPlaceholderText('Search books…'), 'Animal');
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(asked('/inventory?').filter((p) => p.has('q')).map((p) => p.get('q'))).toEqual(['Animal']);
  });
});
