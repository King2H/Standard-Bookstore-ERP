// #23 (M6, step 4): the notification bell moves to features/notifications.
// Its list and unread count are queries for the session branch: the count is
// the server's, a branch switch reads the new branch's notifications and
// reopens the live stream, and a live notification refreshes both. Ids are
// strings, as the contract says. Every mocked answer is checked against its
// contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MarkReadResponseSchema, NotificationListResponseSchema, NotificationSchema, ProfileResponseSchema, UnreadCountResponseSchema,
  type Notification, type ProfileResponse,
} from '@bms/shared';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

function profile(currentBranchId: number): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: [{ branchId: currentBranchId, branchName: 'Home', role: 'Manager' }],
    currentRole: 'Manager', currentRoles: ['Manager'], currentBranchId, locationAccess: { mode: 'full', locations: [] },
  });
}

const notification = (id: string, title: string, over: Partial<Notification> = {}): Notification => contract(NotificationSchema, {
  id, branchId: 1, targetRoles: ['Manager'], targetStaffId: null, eventType: 'order.created', title, body: `${title} body`,
  entityType: null, entityId: null, severity: 'info', isRead: false, readAt: null, createdAt: new Date().toISOString(), ...over,
});

type Call = { method: string; path: string };
let calls: Call[];
let me: ProfileResponse;
let lists: Record<number, Notification[]>;
let unreadCounts: Record<number, number>;
let streams: Array<ReadableStreamDefaultController<Uint8Array>>;

/** Sends an event on the newest open stream. */
const emit = (event: string, data: unknown) => act(async () => {
  streams[streams.length - 1].enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  await new Promise((r) => setTimeout(r, 20));
});

function stubApi() {
  calls = [];
  streams = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const branch = me.currentBranchId;
    if (path === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (path === '/notifications/stream') {
      const body = new ReadableStream<Uint8Array>({ start: (c) => { streams.push(c); } });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path === '/notifications/unread-count') return json(contract(UnreadCountResponseSchema, { count: unreadCounts[branch] ?? 0 }));
    if (path.startsWith('/notifications?')) {
      const data = lists[branch] ?? [];
      return json(contract(NotificationListResponseSchema, { data, total: data.length, page: 1, pageSize: 50, totalPages: 1 }));
    }
    return json(contract(MarkReadResponseSchema, { success: true }));
  }));
}

let qc: QueryClient;
function renderBell() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><NotificationBell onNavigate={vi.fn()} /></ToastProvider></QueryClientProvider>);
}

const bell = (unread: number) => screen.findByRole('button', { name: unread ? `Notifications (${unread} unread)` : 'Notifications' });

beforeEach(() => {
  setAccessToken('x');
  me = profile(1);
  lists = { 1: [notification('1', 'Branch one order'), notification('2', 'Older', { isRead: true })], 2: [notification('3', 'Branch two order', { branchId: 2 })] };
  unreadCounts = { 1: 73, 2: 4 };
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Notification bell', () => {
  it('shows the server\'s unread count (was: the unread among the 50 loaded)', async () => {
    const { unmount } = renderBell();
    expect(await bell(73)).toBeInTheDocument();
    await emit('connected', { unreadCount: 73 });
    expect(await bell(73)).toBeInTheDocument();
    unmount();
  });

  it('reads the new branch\'s notifications and reopens the stream after a branch switch (was: the old branch\'s stayed)', async () => {
    unreadCounts = { 1: 1, 2: 1 }; // each list's own unread, so only the branch differs
    const user = userEvent.setup();
    const { unmount } = renderBell();
    await user.click(await bell(1));
    expect(await screen.findByText('Branch one order')).toBeInTheDocument();
    await waitFor(() => expect(streams).toHaveLength(1));

    me = profile(2);
    await act(() => qc.invalidateQueries()); // what a branch switch does
    expect(await screen.findByText('Branch two order')).toBeInTheDocument();
    expect(screen.queryByText('Branch one order')).not.toBeInTheDocument();
    await waitFor(() => expect(streams).toHaveLength(2));
    unmount();
  });

  it('refreshes the list and the count when a notification arrives live, and shows a warning as a toast', async () => {
    unreadCounts[1] = 1;
    const user = userEvent.setup();
    const { unmount } = renderBell();
    expect(await bell(1)).toBeInTheDocument();
    await waitFor(() => expect(streams).toHaveLength(1));

    const live = notification('900', 'Low stock', { severity: 'warning' });
    lists[1] = [live, ...lists[1]];
    unreadCounts[1] = 2;
    await emit('notification', live);
    expect(await bell(2)).toBeInTheDocument();
    expect(screen.getByText('Low stock: Low stock body')).toBeInTheDocument();
    await user.click(await bell(2));
    expect(await screen.findByRole('button', { name: /Low stock/ })).toBeInTheDocument();
    unmount();
  });

  it('marks a notification read by its id, a string, and lowers the count at once', async () => {
    lists[1] = [notification('9007199254740993', 'Huge id')];
    unreadCounts[1] = 1;
    const user = userEvent.setup();
    const { unmount } = renderBell();
    await user.click(await bell(1));
    unreadCounts[1] = 0;
    await user.click(await screen.findByText('Huge id'));
    await waitFor(() => expect(calls).toContainEqual({ method: 'PUT', path: '/notifications/9007199254740993/read' }));
    expect(await bell(0)).toBeInTheDocument();
    unmount();
  });
});
