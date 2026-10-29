// #171 PR 2 (owner decisions 1a–5a, 2026-10-29): the screens for cash
// sessions. The cashier works with their own session on a Cash tab of the
// POS page: opened with a float, cash put in or taken out with a type and a
// reason, closed with a blind count, the Z report printed. Admin, Manager
// and Finance_Officer see the branch's sessions on a Cash Sessions page
// under Finance, with the X or Z report; an Admin or Manager accepts a count
// beyond the limit, or closes a session left open. The review notification
// opens the session. Before, the screens had no cash session at all. Every
// mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CashSessionDetailSchema, CashSessionListResponseSchema, CurrencyResponseSchema, CurrentCashSessionResponseSchema,
  MarkReadResponseSchema, NotificationListResponseSchema, NotificationSchema, ProfileResponseSchema, UnreadCountResponseSchema,
  type CashMovementCategory, type CashMovementKind, type CashSessionDetail, type ProfileResponse,
} from '@bms/shared';
import { CashTab } from '../features/cashSessions/components/CashTab.js';
import CashSessionsPage from '../features/cashSessions/pages/CashSessionsPage.js';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { canOpenPage, NAV_SECTIONS } from '../app/navigation.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const OPENED = '2026-10-29T06:00:00.000Z';
const CLOSED = '2026-10-29T18:00:00.000Z';

function profile(roles: string[], id = 9): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id, username: 'me', fullName: 'Me', isActive: true, createdAt: OPENED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const movement = (id: number, kind: CashMovementKind, method: string, direction: 'in' | 'out', amount: number, byHand?: { category: CashMovementCategory; reason: string }) => ({
  id, kind, sourceId: byHand ? null : String(id), method, direction, amount, category: byHand?.category ?? null, reason: byHand?.reason ?? null,
  staffId: 9, staffName: 'Sara', createdAt: OPENED,
});

/** Sara's session 3: float 200, a cash sale of 50, a Telebirr sale of 30, a bank drop of 100. */
function session(over: Partial<CashSessionDetail> = {}, view: 'own' | 'full' = 'full'): CashSessionDetail {
  const movements = [
    movement(1, 'pos_payment', 'cash', 'in', 50),
    movement(2, 'pos_payment', 'mobile', 'in', 30),
    movement(3, 'pay_out', 'cash', 'out', 100, { category: 'bank_drop', reason: 'Deposit at CBE' }),
  ];
  const open = (over.status ?? 'open') === 'open';
  return contract(CashSessionDetailSchema, {
    id: 3, branchId: 1, branchName: 'Home', staffId: 9, staffName: 'Sara', status: 'open', currency: 'ETB', openingFloat: 200, openedAt: OPENED,
    expectedCash: view === 'own' && open ? null : 150, countedCash: null, variance: null, closeNote: null,
    closedBy: null, closedByName: null, closedAt: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, zNumber: null,
    totals: view === 'own' && open ? null : [
      { kind: 'pay_out', method: 'cash', direction: 'out', count: 1, amount: 100 },
      { kind: 'pos_payment', method: 'cash', direction: 'in', count: 1, amount: 50 },
      { kind: 'pos_payment', method: 'mobile', direction: 'in', count: 1, amount: 30 },
    ],
    movements: view === 'own' && open ? movements.filter((m) => m.kind === 'pay_out') : movements,
    ...over,
  });
}

const closed = (over: Partial<CashSessionDetail> = {}) => session({
  status: 'closed', expectedCash: 150, countedCash: 148, variance: -2, closedBy: 9, closedByName: 'Sara', closedAt: CLOSED,
  zNumber: 'Z-20261029-0001', ...over,
});

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let current: { required: boolean; session: CashSessionDetail | null };
let sessions: CashSessionDetail[];
let answer: CashSessionDetail;

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
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: 'ETB' }));
    if (u.pathname === '/cash-sessions/current') return json(contract(CurrentCashSessionResponseSchema, current));
    if (u.pathname === '/cash-sessions' && method === 'GET') {
      const status = u.searchParams.get('status');
      const items = sessions.filter((s) => !status || s.status === status).map(({ totals: _t, movements: _m, ...s }) => s);
      return json(contract(CashSessionListResponseSchema, { items, total: items.length, page: 1, pageSize: 25, totalPages: 1 }));
    }
    if (/^\/cash-sessions\/\d+$/.test(u.pathname) && method === 'GET') {
      return json(contract(CashSessionDetailSchema, sessions.find((s) => s.id === Number(u.pathname.split('/')[2])) ?? answer));
    }
    if (u.pathname.startsWith('/cash-sessions') && method === 'POST') {
      return json(contract(CashSessionDetailSchema, answer), u.pathname === '/cash-sessions' || u.pathname.endsWith('/movements') ? 201 : 200);
    }
    if (u.pathname === '/notifications/stream') return new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    if (u.pathname === '/notifications/unread-count') return json(contract(UnreadCountResponseSchema, { count: 1 }));
    if (u.pathname === '/notifications') {
      const data = [contract(NotificationSchema, {
        id: '51', branchId: 1, targetRoles: ['Manager', 'Admin'], targetStaffId: null, eventType: 'cash_session.review_needed',
        title: '💵 Cash count to review', body: 'Z-20261029-0002: Sara counted over by 80.00', entityType: 'cash_session',
        entityId: '4', severity: 'warning', isRead: false, readAt: null, createdAt: new Date().toISOString(),
      })];
      return json(contract(NotificationListResponseSchema, { data, total: 1, page: 1, pageSize: 50, totalPages: 1 }));
    }
    if (u.pathname.startsWith('/notifications/')) return json(contract(MarkReadResponseSchema, { success: true }));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

function show(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  current = { required: false, session: null };
  sessions = [];
  answer = session({}, 'own');
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe("the cashier's Cash tab (1a)", () => {
  it('opens a session with a float, 0 when the drawer starts empty', async () => {
    const user = show(<CashTab />);
    expect(await screen.findByText('No cash session open')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Opening float'), '0');
    await user.click(screen.getByRole('button', { name: 'Open session' }));
    await waitFor(() => expect(posted('/cash-sessions')).toEqual([{ openingFloat: '0' }]));
  });

  it('says when the branch takes cash only with a session', async () => {
    current = { required: true, session: null };
    show(<CashTab />);
    expect(await screen.findByText(/This branch takes cash only with an open cash session/)).toBeInTheDocument();
  });

  it('shows the open session without what is expected, so the count stays blind', async () => {
    current = { required: false, session: session({}, 'own') };
    show(<CashTab />);
    expect(await screen.findByText('Session open')).toBeInTheDocument();
    expect(screen.getByText(/ETB 200\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/Expected/)).toBeNull();
    expect(screen.getByText('Deposit at CBE')).toBeInTheDocument();
  });

  it('puts cash in or takes it out with a type that fits the direction and a reason', async () => {
    current = { required: false, session: session({}, 'own') };
    const user = show(<CashTab />);
    await user.click(await screen.findByRole('button', { name: 'Cash in / out' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Direction'), 'out');
    expect(within(within(dialog).getByLabelText('Type')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Bank drop', 'Petty cash', 'Other']);
    await user.selectOptions(within(dialog).getByLabelText('Direction'), 'in');
    expect(within(within(dialog).getByLabelText('Type')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Float top-up', 'Other']);
    await user.selectOptions(within(dialog).getByLabelText('Direction'), 'out');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'petty_cash');
    await user.type(within(dialog).getByLabelText('Amount'), '25');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason'), 'Tea');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/cash-sessions/3/movements')).toEqual([{ direction: 'out', category: 'petty_cash', amount: '25', reason: 'Tea' }]));
  });

  it('closes with a blind count, then shows the result and prints the Z report', async () => {
    current = { required: false, session: session({}, 'own') };
    answer = closed();
    const user = show(<CashTab />);
    await user.click(await screen.findByRole('button', { name: 'Close session' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/Expected|150/)).toBeNull();
    await user.type(within(dialog).getByLabelText('Cash counted'), '148');
    await user.type(within(dialog).getByLabelText('Note'), 'Short by two');
    await user.click(within(dialog).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(posted('/cash-sessions/3/close')).toEqual([{ countedCash: '148', note: 'Short by two' }]));
    expect(await screen.findByText('Z-20261029-0001')).toBeInTheDocument();
    expect(screen.getAllByText(/Short ETB 2\.00/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '🖨 Print Z report' }));
    const slip = screen.getByRole('dialog', { name: 'Z report Z-20261029-0001' });
    for (const text of ['Sara', 'Opening float', 'Expected', 'Counted', 'POS sale', 'Bank drop', 'Counted by', 'Checked by']) {
      expect(within(slip).getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    }
  });
});

describe('the Cash Sessions page (2a)', () => {
  it('lists the branch\'s sessions, filtered by status, and opens one with its report', async () => {
    me = profile(['Finance_Officer'], 12);
    sessions = [closed({ id: 3 }), closed({ id: 4, status: 'pending_review', variance: 80, countedCash: 230, zNumber: 'Z-20261029-0002' })];
    const user = show(<CashSessionsPage />);
    expect(await screen.findByText('Z-20261029-0001')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Waiting for review')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'pending_review');
    await settle();
    expect(calls.some((c) => c.path.startsWith('/cash-sessions?status=pending_review&page=1'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Z-20261029-0002' }));
    expect(await screen.findByRole('heading', { name: /Z-20261029-0002/ })).toBeInTheDocument();
    expect(screen.getByText('Over ETB 80.00')).toBeInTheDocument();
    expect(screen.getAllByText('POS sale').length).toBeGreaterThan(0);
    // A Finance_Officer reads; accepting and closing are a Manager's or an Admin's.
    expect(screen.queryByRole('button', { name: 'Accept count' })).toBeNull();
  });

  it('lets a Manager accept a count beyond the limit, with a reason', async () => {
    me = profile(['Manager'], 15);
    sessions = [closed({ id: 4, status: 'pending_review', variance: 80, countedCash: 230, zNumber: 'Z-20261029-0002' })];
    answer = closed({ id: 4, variance: 80, countedCash: 230, reviewedBy: 15, reviewedByName: 'Mgr', reviewedAt: CLOSED, reviewReason: 'Old debt paid in cash' });
    const user = show(<CashSessionsPage initialContext={{ sessionId: '4' }} />);
    await user.click(await screen.findByRole('button', { name: 'Accept count' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Accept' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason'), 'Old debt paid in cash');
    await user.click(within(dialog).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(posted('/cash-sessions/4/review')).toEqual([{ reason: 'Old debt paid in cash' }]));
  });

  it("lets a Manager close a session left open, and print its X report while open", async () => {
    me = profile(['Manager'], 15);
    sessions = [session({ id: 5 })];
    answer = closed({ id: 5 });
    const user = show(<CashSessionsPage initialContext={{ sessionId: '5' }} />);
    expect(await screen.findByText('Expected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '🖨 Print X report' }));
    expect(screen.getByRole('dialog', { name: 'X report — Sara' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog', { name: 'X report — Sara' })).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Close for Sara' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Cash counted'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(posted('/cash-sessions/5/close')).toEqual([{ countedCash: '150', note: null }]));
  });

  it('is in the menu under Finance for Admin, Manager and Finance_Officer, not Sales', () => {
    const finance = NAV_SECTIONS.find((s) => s.id === 'finance')!;
    expect(finance.items.map((i) => i.id)).toContain('cash-sessions');
    expect(canOpenPage('cash-sessions', 'Finance_Officer', ['Finance_Officer'], ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS'])).toBe(true);
    expect(canOpenPage('cash-sessions', 'Manager', ['Manager'], ['VIEW_REPORTS'])).toBe(true);
    expect(canOpenPage('cash-sessions', 'Sales', ['Sales'], ['CREATE_SALE', 'PROCESS_PAYMENT'])).toBe(false);
    expect(canOpenPage('cash-sessions', 'Purchasor', ['Purchasor'], ['MANAGE_INVENTORY', 'VIEW_REPORTS'])).toBe(false);
  });

  it('is opened on the session by the review notification', async () => {
    const onNavigate = vi.fn();
    const user = show(<NotificationBell onNavigate={onNavigate} />);
    await user.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await user.click(await screen.findByText('💵 Cash count to review'));
    expect(onNavigate).toHaveBeenCalledWith('cash-sessions', { sessionId: '4' });
  });
});
