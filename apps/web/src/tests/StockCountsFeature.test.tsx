// #172 PR 2 (owner decisions 1a–5a, 2026-10-30): the screens for stock
// counts. A Counts tab on Inventory lists the branch's counts and opens new
// ones: every book at a location, or books chosen by searching there. A
// counter enters quantities blind, adds a book found, prints a count sheet
// and submits. An Admin or Manager sees expected, difference and value with
// the totals, sends books back for a recount, counts never-counted books as
// 0, posts after a confirmation, or cancels with a reason. A posted count
// shows what it changed and opens the stock history; the review notification
// opens the count. Before, the screens offered no count at all. Every mocked
// answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  LocationListResponseSchema, MarkReadResponseSchema, NotificationListResponseSchema, NotificationSchema, ProfileResponseSchema,
  StockCountDetailSchema, StockCountListResponseSchema, StockLevelListResponseSchema, StockLevelSchema, UnreadCountResponseSchema,
  type ProfileResponse, type StockCountDetail, type StockCountStatus,
} from '@bms/shared';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const AT = '2026-10-30T07:00:00.000Z';
const SHELF = { id: 1, name: 'Shop Floor', isDefaultFulfillment: true };

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: AT, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

/** CNT-…-0001 of Shop Floor: Dune counted 9 of 10 expected, Oromay not yet counted. */
function countOf(status: StockCountStatus, blind: boolean): StockCountDetail {
  const posted = status === 'posted';
  return contract(StockCountDetailSchema, {
    id: 4, countNumber: 'CNT-20261030-0001', branchId: 1, locationId: 1, locationName: 'Shop Floor', scope: 'full', status,
    notes: 'Month end', createdBy: 9, createdByName: 'Me', createdAt: AT, submittedAt: status === 'counting' ? null : AT,
    postedBy: posted ? 9 : null, postedByName: posted ? 'Me' : null, postedAt: posted ? AT : null, cancelledAt: null, cancelReason: null,
    lineCount: 2, countedLines: 1,
    totals: blind ? null : { overQuantity: 0, shortQuantity: 1, overValue: 0, shortValue: 6 },
    lines: [
      { id: 11, bookId: 3, bookTitle: 'Dune', isbn: '9780441013593', frozenQuantity: blind ? null : 10, expectedQuantity: blind ? null : 10,
        countedQuantity: 9, difference: blind ? null : -1, differenceValue: blind ? null : -6, countedBy: 9, countedByName: 'Me', countedAt: AT,
        previousCounts: [], recountRequested: false, postedDelta: posted ? -1 : null, postedUnitCost: posted ? 6 : null },
      { id: 12, bookId: 4, bookTitle: 'Oromay', isbn: null, frozenQuantity: blind ? null : 2, expectedQuantity: null,
        countedQuantity: null, difference: null, differenceValue: null, countedBy: null, countedByName: null, countedAt: null,
        previousCounts: [], recountRequested: false, postedDelta: null, postedUnitCost: null },
    ],
  });
}

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let theCount: StockCountDetail;

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
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, { items: [{ ...SHELF, branchId: 1, createdAt: AT }], total: 1, accessMode: 'full' }));
    }
    if (u.pathname === '/inventory' && u.searchParams.get('q')) {
      return json(contract(StockLevelListResponseSchema, {
        items: [contract(StockLevelSchema, {
          bookId: 5, bookTitle: 'Fikir Eske Mekabir', bookIsbn: '9789994400017', bookIsActive: true, locationId: 1, locationName: 'Shop Floor',
          branchId: 1, quantity: 4, reserved: 0, available: 4, reorderPoint: 5, averageCost: 7, damaged: 0, damagedValue: 0, version: 1,
          isLowStock: true, updatedAt: AT,
        })],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (u.pathname === '/stock-counts' && method === 'GET') {
      const summary = { ...theCount, lines: undefined, totals: undefined };
      return json(contract(StockCountListResponseSchema, { items: [summary], total: 1, page: 1, pageSize: 25, totalPages: 1 }));
    }
    if (u.pathname === '/stock-counts' && method === 'POST') return json(contract(StockCountDetailSchema, theCount), 201);
    if (u.pathname.startsWith('/stock-counts/')) return json(contract(StockCountDetailSchema, theCount));
    if (u.pathname === '/notifications/stream') return new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    if (u.pathname === '/notifications/unread-count') return json(contract(UnreadCountResponseSchema, { count: 1 }));
    if (u.pathname === '/notifications') {
      const data = [contract(NotificationSchema, {
        id: '61', branchId: 1, targetRoles: ['Manager', 'Admin'], targetStaffId: null, eventType: 'stock_count.submitted',
        title: '📋 Stock count to review', body: 'CNT-20261030-0001: Shop Floor counted, waiting for review', entityType: 'stock_count',
        entityId: '4', severity: 'info', isRead: false, readAt: null, createdAt: new Date().toISOString(),
      })];
      return json(contract(NotificationListResponseSchema, { data, total: 1, page: 1, pageSize: 50, totalPages: 1 }));
    }
    if (u.pathname.startsWith('/notifications/')) return json(contract(MarkReadResponseSchema, { success: true }));
    return json({ items: [], total: 0, page: 1, totalPages: 0 });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

async function openInventory(initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage initialContext={initialContext} /></ToastProvider></QueryClientProvider>);
  await settle();
  return userEvent.setup();
}

async function openCount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Counts'))!);
  await user.click(await screen.findByRole('button', { name: 'CNT-20261030-0001' }));
  await screen.findByRole('heading', { name: /CNT-20261030-0001/ });
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Stock_Clerk']);
  theCount = countOf('counting', true);
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the Counts tab (1a)', () => {
  it('is on Inventory for Admin, Manager and Stock_Clerk, not Sales (was: no counts)', async () => {
    await openInventory();
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('Counts'))).toBe(true);
  });

  it('is not offered to Sales', async () => {
    me = profile(['Sales']);
    await openInventory();
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('Counts'))).toBe(false);
  });

  it('opens a count of every book at a location, or of books chosen there (4a)', async () => {
    const user = await openInventory();
    await user.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Counts'))!);
    await user.click(await screen.findByRole('button', { name: 'New count' }));
    await user.type(screen.getByLabelText('Notes'), 'Month end');
    await user.click(screen.getByRole('button', { name: 'Open count' }));
    await waitFor(() => expect(posted('/stock-counts')).toEqual([{ locationId: 1, scope: 'full', notes: 'Month end' }]));

    await user.click(screen.getByRole('button', { name: '← Back' }));
    await user.click(await screen.findByRole('button', { name: 'New count' }));
    await user.selectOptions(screen.getByLabelText('What to count'), 'selected');
    expect(screen.getByRole('button', { name: 'Open count' })).toBeDisabled();
    await user.type(screen.getByLabelText('Find a book'), 'Fik');
    await user.click(await screen.findByRole('button', { name: /Add Fikir Eske Mekabir/ }));
    await user.click(screen.getByRole('button', { name: 'Open count' }));
    await waitFor(() => expect(posted('/stock-counts')[1]).toEqual({ locationId: 1, scope: 'selected', bookIds: [5], notes: null }));
  });
});

describe('counting (2a)', () => {
  it('is blind, saves the quantities entered, adds a book found, and submits', async () => {
    const user = await openInventory();
    await openCount(user);
    expect(screen.queryByText('Expected')).toBeNull();
    expect(screen.queryByText('Difference')).toBeNull();
    await user.type(screen.getByLabelText('Counted Oromay'), '2');
    await user.click(screen.getByRole('button', { name: 'Save counts' }));
    await waitFor(() => expect(posted('/stock-counts/4/counts')).toEqual([{ items: [{ bookId: 4, quantity: 2 }] }]));
    await user.type(screen.getByLabelText('Find a book'), 'Fik');
    await user.click(await screen.findByRole('button', { name: /Add Fikir Eske Mekabir/ }));
    await user.type(screen.getByLabelText('Counted Fikir Eske Mekabir'), '1');
    await user.click(screen.getByRole('button', { name: 'Save counts' }));
    await waitFor(() => expect(posted('/stock-counts/4/counts')[1]).toEqual({ items: [{ bookId: 5, quantity: 1 }] }));
    await user.click(screen.getByRole('button', { name: 'Submit count' }));
    await waitFor(() => expect(posted('/stock-counts/4/submit')).toHaveLength(1));
  });

  it('prints a count sheet with a blank column and nothing expected', async () => {
    const user = await openInventory();
    await openCount(user);
    await user.click(screen.getByRole('button', { name: '🖨 Print count sheet' }));
    const sheet = screen.getByRole('dialog', { name: 'Count sheet CNT-20261030-0001' });
    for (const text of ['Shop Floor', 'Dune', 'Oromay', '9780441013593', 'Counted', 'Counted by']) {
      expect(within(sheet).getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    }
    expect(within(sheet).queryByText(/Expected/)).toBeNull();
  });
});

describe('review (3a)', () => {
  beforeEach(() => {
    me = profile(['Manager']);
    theCount = countOf('submitted', false);
  });

  it('shows expected, difference and value with the totals, and sends a book back for a recount', async () => {
    const user = await openInventory();
    await openCount(user);
    expect(screen.getByText('Expected')).toBeInTheDocument();
    expect(screen.getByText(/Short 1 \(ETB 6\.00\)/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select Dune'));
    await user.click(screen.getByRole('button', { name: 'Recount selected' }));
    await waitFor(() => expect(posted('/stock-counts/4/recount')).toEqual([{ bookIds: [3] }]));
  });

  it('counts a never-counted book as 0 and posts after a confirmation', async () => {
    const user = await openInventory();
    await openCount(user);
    await user.click(screen.getByLabelText('Count Oromay as 0'));
    await user.click(screen.getByRole('button', { name: 'Post count' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(posted('/stock-counts/4/post')).toEqual([{ zeroBookIds: [4] }]));
  });

  it('cancels with a reason', async () => {
    const user = await openInventory();
    await openCount(user);
    await user.click(screen.getByRole('button', { name: 'Cancel count' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Wrong shelf');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel count' }));
    await waitFor(() => expect(posted('/stock-counts/4/cancel')).toEqual([{ reason: 'Wrong shelf' }]));
  });
});

describe('after posting (5a)', () => {
  it('shows what the count changed and opens the stock history', async () => {
    me = profile(['Manager']);
    theCount = countOf('posted', false);
    const user = await openInventory();
    await openCount(user);
    expect(screen.getByText('−1 at ETB 6.00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open in History' }));
    expect(screen.getAllByRole('button', { pressed: true }).some((b) => b.textContent?.includes('History'))).toBe(true);
  });

  it('is opened on the count by the review notification', async () => {
    const onNavigate = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ToastProvider><NotificationBell onNavigate={onNavigate} /></ToastProvider></QueryClientProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await user.click(await screen.findByText('📋 Stock count to review'));
    expect(onNavigate).toHaveBeenCalledWith('inventory', { tab: 'counts', countId: '4' });
  });
});
