// #170 PR 2 (owner decisions 1a–5a, 2026-10-27): the screens for transfers
// between branches. Inventory's within-branch Transfer tab becomes Move;
// Outgoing and Incoming list the notes the branch sends and receives. A note
// is drafted with books found at the source location, never more than it
// holds, and dispatched after a confirmation; the receiving branch receives
// what is still on the way into one of its locations; an Admin or Manager
// resolves what did not arrive, with a reason: lost or damaged by the
// receiving branch, returned by the sending branch. A slip is printed to go
// with the books; the dashboard shows the value in transit; the dispatch
// notification opens Incoming on the note. Before, the screens offered no
// transfer between branches. Every mocked answer is checked against its
// contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BranchListResponseSchema, LocationListResponseSchema, MarkReadResponseSchema, NotificationListResponseSchema, NotificationSchema,
  ProfileResponseSchema, StockLevelListResponseSchema, StockLevelSchema, TransferListResponseSchema, TransferSchema,
  UnreadCountResponseSchema, type ProfileResponse, type Transfer, type TransferStatus,
} from '@bms/shared';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { KpiCard } from '../features/dashboard/components/cards.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-27T07:00:00.000Z';
const SHOP = { id: 1, name: 'Shop Floor', isDefaultFulfillment: true };
const BACK = { id: 2, name: 'Back Store', isDefaultFulfillment: false };
const PIASSA = { id: 7, name: 'Piassa shelf', isDefaultFulfillment: true };

function profile(roles: string[], branchId = 1, restrictedTo?: (typeof SHOP)[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId, branchName: branchId === 1 ? 'Home' : 'Piassa', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: branchId,
    locationAccess: restrictedTo ? { mode: 'restricted', locations: restrictedTo } : { mode: 'full', locations: [] },
  });
}

const branch = (id: number, name: string) => ({
  id, name, address: 'Addis Ababa', contactInfo: {}, operatingHours: {}, isActive: true, createdAt: CREATED,
});

/** A note from Home (Shop Floor) to Piassa: 6 copies of Dune at 5.00 and 2 of Oromay at 8.00. */
function note(status: TransferStatus, done: { received?: number; lost?: number } = {}): Transfer {
  const sent = status !== 'draft' && status !== 'cancelled';
  const received = done.received ?? 0;
  const lost = done.lost ?? 0;
  return contract(TransferSchema, {
    id: 5, transferNumber: 'TRF-20261027-0001', fromBranchId: 1, fromBranchName: 'Home', fromLocationId: 1, fromLocationName: 'Shop Floor',
    toBranchId: 2, toBranchName: 'Piassa', status, notes: 'Opening stock for Piassa',
    inTransitValue: sent ? (6 - received - lost) * 5 + 2 * 8 : 0, totalQuantity: 8,
    createdBy: 9, createdByName: 'Me', createdAt: CREATED, dispatchedBy: sent ? 9 : null, dispatchedAt: sent ? CREATED : null,
    cancelledBy: null, cancelledAt: null, completedAt: null,
    lines: [
      { id: 11, bookId: 3, bookTitle: 'Dune', isbn: '9780441013593', quantity: 6, unitCost: sent ? 5 : null,
        receivedQuantity: received, lostQuantity: lost, damagedQuantity: 0, returnedQuantity: 0, outstandingQuantity: sent ? 6 - received - lost : 0 },
      { id: 12, bookId: 4, bookTitle: 'Oromay', isbn: null, quantity: 2, unitCost: sent ? 8 : null,
        receivedQuantity: 0, lostQuantity: 0, damagedQuantity: 0, returnedQuantity: 0, outstandingQuantity: sent ? 2 : 0 },
    ],
    events: received ? [{
      id: 1, lineId: 11, bookTitle: 'Dune', kind: 'received', quantity: received, locationId: 7, locationName: 'Piassa shelf',
      reason: null, staffId: 9, staffName: 'Me', createdAt: CREATED,
    }] : [],
  });
}

const stock = (bookId: number, title: string, quantity: number) => contract(StockLevelSchema, {
  bookId, bookTitle: title, bookIsbn: '9780441013593', bookIsActive: true, locationId: 1, locationName: 'Shop Floor',
  branchId: 1, quantity, reserved: 0, available: quantity, reorderPoint: 5, averageCost: 5, damaged: 0, damagedValue: 0, version: 1,
  isLowStock: false, updatedAt: CREATED,
});

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let theNote: Transfer;

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
    if (u.pathname === '/branches') {
      return json(contract(BranchListResponseSchema, { items: [branch(1, 'Home'), branch(2, 'Piassa')], total: 2, page: 1, pageSize: 100, totalPages: 1 }));
    }
    if (u.pathname === '/branches/1/locations' || u.pathname === '/branches/2/locations') {
      const all = u.pathname === '/branches/1/locations' ? [SHOP, BACK] : [PIASSA];
      const restricted = me.locationAccess.mode === 'restricted' && u.searchParams.get('all') !== 'true';
      const items = (restricted ? me.locationAccess.locations : all).map((l) => ({ ...l, branchId: Number(u.pathname.split('/')[2]), createdAt: CREATED }));
      return json(contract(LocationListResponseSchema, { items, total: items.length, accessMode: me.locationAccess.mode }));
    }
    if (u.pathname === '/inventory' && u.searchParams.get('q')) {
      return json(contract(StockLevelListResponseSchema, list([stock(3, 'Dune', 12)])));
    }
    if (u.pathname === '/transfers' && method === 'GET') {
      const mine = u.searchParams.get('direction') === 'incoming' ? theNote.toBranchId : theNote.fromBranchId;
      const items = mine === me.currentBranchId ? [theNote] : [];
      return json(contract(TransferListResponseSchema, {
        items: items.map(({ lines: _l, events: _e, ...summary }) => summary), total: items.length, page: 1, pageSize: 25, totalPages: 1,
      }));
    }
    // A note just saved (id 6) opens like the one in the lists (id 5).
    if (/^\/transfers\/\d+$/.test(u.pathname) && method === 'GET') return json(contract(TransferSchema, { ...theNote, id: Number(u.pathname.split('/')[2]) }));
    if (u.pathname === '/transfers' && method === 'POST') return json(contract(TransferSchema, { ...note('draft'), id: 6 }), 201);
    if (u.pathname.startsWith('/transfers/') && method !== 'GET') return json(contract(TransferSchema, theNote));
    if (u.pathname === '/notifications/stream') return new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    if (u.pathname === '/notifications/unread-count') return json(contract(UnreadCountResponseSchema, { count: 1 }));
    if (u.pathname === '/notifications') {
      const data = [contract(NotificationSchema, {
        id: '41', branchId: 2, targetRoles: ['Stock_Clerk', 'Manager', 'Admin'], targetStaffId: null, eventType: 'transfer.dispatched',
        title: '🚚 Transfer on its way', body: 'TRF-20261027-0001: 8 copies from Home to receive', entityType: 'branch_transfer',
        entityId: '5', severity: 'info', isRead: false, readAt: null, createdAt: new Date().toISOString(),
      })];
      return json(contract(NotificationListResponseSchema, { data, total: 1, page: 1, pageSize: 50, totalPages: 1 }));
    }
    if (u.pathname.startsWith('/notifications/')) return json(contract(MarkReadResponseSchema, { success: true }));
    return json(list([]));
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method !== 'GET' && c.path === path).map((c) => c.body);
const tabNames = () => screen.getAllByRole('button', { pressed: false }).concat(screen.getAllByRole('button', { pressed: true }))
  .map((b) => b.textContent?.replace(/[^\w ]/g, '').trim());

async function openInventory(initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage initialContext={initialContext} /></ToastProvider></QueryClientProvider>);
  await settle();
  return userEvent.setup();
}

async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/[^\w ]/g, '').trim() === name)!);
  await settle();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Stock_Clerk']);
  theNote = note('in_transit');
  stubApi();
});
afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('Inventory tabs (1a)', () => {
  it('names the move within the branch Move, and lists notes Outgoing and Incoming (was: no transfer between branches)', async () => {
    await openInventory();
    const names = tabNames();
    expect(names).toEqual(expect.arrayContaining(['Move', 'Outgoing', 'Incoming']));
    expect(names).not.toContain('Transfer');
  });

  it('are not offered to roles that do not move stock', async () => {
    me = profile(['Sales']);
    await openInventory();
    expect(tabNames()).not.toEqual(expect.arrayContaining(['Outgoing']));
    expect(tabNames()).not.toEqual(expect.arrayContaining(['Incoming']));
  });
});

describe('a new transfer (2a)', () => {
  async function newTransfer() {
    const user = await openInventory();
    await openTab(user, 'Outgoing');
    await user.click(screen.getByRole('button', { name: 'New transfer' }));
    await settle();
    return user;
  }

  it('sends from a location one may use to another open branch, never more than the source holds', async () => {
    me = profile(['Stock_Clerk'], 1, [SHOP]);
    const user = await newTransfer();
    const from = screen.getByRole('combobox', { name: 'From location' });
    expect(within(from).getAllByRole('option').map((o) => o.textContent)).toEqual(['Shop Floor (default)']);
    const to = screen.getByRole('combobox', { name: 'To branch' });
    expect(within(to).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Select branch —', 'Piassa']);

    await user.type(screen.getByRole('textbox', { name: 'Find a book' }), 'Dune');
    await user.click(await screen.findByRole('button', { name: /Add Dune.*12 on hand/ }));
    const qty = screen.getByRole('spinbutton', { name: 'Quantity of Dune' });
    await user.clear(qty);
    await user.type(qty, '13');
    expect(screen.getByText('Only 12 on hand')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await user.clear(qty);
    await user.type(qty, '6');
    await user.selectOptions(to, '2');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(posted('/transfers')).toHaveLength(1));
    expect(posted('/transfers')[0]).toEqual({ fromLocationId: 1, toBranchId: 2, lines: [{ bookId: 3, quantity: 6 }], notes: null });
    expect(posted('/transfers/6/dispatch')).toHaveLength(0);
  });

  it('is dispatched after a confirmation in the app\'s dialog', async () => {
    const user = await newTransfer();
    await user.selectOptions(screen.getByRole('combobox', { name: 'To branch' }), '2');
    await user.type(screen.getByRole('textbox', { name: 'Find a book' }), 'Dune');
    await user.click(await screen.findByRole('button', { name: /Add Dune/ }));
    await user.click(screen.getByRole('button', { name: 'Dispatch' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/leave Shop Floor now/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch' }));
    await waitFor(() => expect(posted('/transfers/6/dispatch')).toHaveLength(1));
    expect(posted('/transfers')[0]).toMatchObject({ lines: [{ bookId: 3, quantity: 1 }] });
  });
});

describe('a draft (1a)', () => {
  it('is cancelled or dispatched by the sending branch', async () => {
    theNote = note('draft');
    const user = await openInventory({ tab: 'outgoing', transferId: '5' });
    expect(await screen.findByRole('heading', { name: /TRF-20261027-0001/ })).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel transfer' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel transfer' }));
    await waitFor(() => expect(posted('/transfers/5/cancel')).toHaveLength(1));
  });
});

describe('receiving (3a)', () => {
  it('takes in what is still on the way, into a location of the receiving branch', async () => {
    setCurrentBranchId(2);
    me = profile(['Stock_Clerk'], 2);
    theNote = note('partially_received', { received: 2 });
    const user = await openInventory();
    await openTab(user, 'Incoming');
    await user.click(await screen.findByText('TRF-20261027-0001'));
    await settle();
    expect(screen.getByText('Partly received')).toBeInTheDocument();
    const dune = screen.getByRole('spinbutton', { name: 'Receive quantity of Dune' });
    expect(dune).toHaveValue(4);
    expect(screen.getByRole('spinbutton', { name: 'Receive quantity of Oromay' })).toHaveValue(2);
    await user.clear(dune);
    await user.type(dune, '3');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Receive into' }), '7');
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await waitFor(() => expect(posted('/transfers/5/receive')).toHaveLength(1));
    expect(posted('/transfers/5/receive')[0]).toEqual({ locationId: 7, items: [{ lineId: 11, quantity: 3 }, { lineId: 12, quantity: 2 }] });
    // A Stock_Clerk receives but does not resolve.
    expect(screen.queryByRole('button', { name: /^Resolve/ })).toBeNull();
  });
});

describe('what did not arrive (4a)', () => {
  it('is lost or damaged as the receiving branch says, by a Manager, with a reason', async () => {
    setCurrentBranchId(2);
    me = profile(['Manager'], 2);
    const user = await openInventory({ tab: 'incoming', transferId: '5' });
    await screen.findByRole('heading', { name: /TRF-20261027-0001/ });
    await user.click(screen.getByRole('button', { name: 'Resolve Dune' }));
    const dialog = screen.getByRole('dialog');
    const outcome = within(dialog).getByRole('combobox', { name: 'What happened' });
    expect(within(outcome).getAllByRole('option').map((o) => o.textContent)).toEqual(['Lost', 'Damaged']);
    await user.selectOptions(outcome, 'damaged');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(within(dialog).getByText('A reason is required')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Into location' }), '7');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Copies' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Copies' }), '1');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Wet cover');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(posted('/transfers/5/resolve')).toHaveLength(1));
    expect(posted('/transfers/5/resolve')[0]).toEqual({ lineId: 11, outcome: 'damaged', quantity: 1, reason: 'Wet cover', locationId: 7 });
  });

  it('is returned as the sending branch says, onto one of its shelves', async () => {
    me = profile(['Manager']);
    const user = await openInventory({ tab: 'outgoing', transferId: '5' });
    await screen.findByRole('heading', { name: /TRF-20261027-0001/ });
    expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resolve Oromay' }));
    const dialog = screen.getByRole('dialog');
    expect(within(within(dialog).getByRole('combobox', { name: 'What happened' })).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Returned to us']);
    expect(within(within(dialog).getByRole('combobox', { name: 'Into location' })).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['— Select location —', 'Shop Floor (default)', 'Back Store']);
  });
});

describe('the slip (5a)', () => {
  it('goes with the books: number, both branches, books, quantities and signatures', async () => {
    const user = await openInventory({ tab: 'outgoing', transferId: '5' });
    await screen.findByRole('heading', { name: /TRF-20261027-0001/ });
    await user.click(screen.getByRole('button', { name: '🖨 Print slip' }));
    const slip = screen.getByRole('dialog', { name: 'Transfer TRF-20261027-0001' });
    for (const text of ['Home (Shop Floor)', 'Piassa', 'Dune', 'Oromay', 'Sent by', 'Received by']) {
      expect(within(slip).getAllByText(new RegExp(text.replace(/[()]/g, '\\$&'))).length).toBeGreaterThan(0);
    }
  });
});

describe('the dashboard and the notification (5a)', () => {
  it('shows the value in transit under the inventory value, when there is some', () => {
    const { rerender } = render(<KpiCard label="Inventory Value" value="ETB 100" sub="Qty on hand × average cost" extra="In transit ETB 30" icon={null} color="" />);
    expect(screen.getByText('In transit ETB 30')).toBeInTheDocument();
    rerender(<KpiCard label="Inventory Value" value="ETB 100" sub="Qty on hand × average cost" icon={null} color="" />);
    expect(screen.queryByText(/In transit/)).toBeNull();
  });

  it('opens Incoming on the note', async () => {
    const onNavigate = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ToastProvider><NotificationBell onNavigate={onNavigate} /></ToastProvider></QueryClientProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await user.click(await screen.findByText('🚚 Transfer on its way'));
    expect(onNavigate).toHaveBeenCalledWith('inventory', { tab: 'incoming', transferId: '5' });
  });
});
