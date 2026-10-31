// #175 PR 2 (owner decisions 1a–6a, 2026-10-31): the screens for closing a
// branch's day and the shop's month. Finance → Day Close has two tabs. Days:
// the month's calendar for the session branch; a day opens with its report
// so far (or as kept), what stops it closing, Close, Print and, for an Admin,
// Reopen with a reason. Months: a year's months; a month shows whether it has
// ended, the days each branch still has to close, its summary, Close and
// Reopen. A banner across the app says when the branch's day is closed; the
// time zone is set under Settings → General. Before, the screens had no
// close at all. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BusinessDayDetailSchema, BusinessDayListResponseSchema, BusinessMonthDetailSchema, BusinessMonthListResponseSchema,
  DayPreviewSchema, MarkReadResponseSchema, MonthPreviewSchema, NotificationListResponseSchema, NotificationSchema,
  ProfileResponseSchema, TodayStatusSchema, UnreadCountResponseSchema,
  type BusinessDayDetail, type DayPreview, type DayReport, type MonthPreview, type ProfileResponse,
} from '@bms/shared';
import DayClosePage from '../features/businessDays/pages/DayClosePage.js';
import { ClosedDayBanner } from '../features/businessDays/components/ClosedDayBanner.js';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { canOpenPage, NAV_SECTIONS } from '../app/navigation.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const TODAY = '2026-10-31';
const CLOSED_AT = '2026-10-31T18:00:00.000Z';

function profile(roles: string[], id = 9): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id, username: 'me', fullName: 'Me', isActive: true, createdAt: CLOSED_AT, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const REPORT: DayReport = {
  sales: { orders: { count: 2, total: 300 }, pos: { count: 5, total: 450.5 }, exchanges: { count: 1 } },
  money: { byMethod: [{ method: 'cash', in: 600.5, out: 20 }, { method: 'bank', in: 150, out: 1000 }], totalIn: 750.5, totalOut: 1020 },
  returns: { count: 1, refunded: 20 },
  stock: [{ reason: 'sale', in: 0, out: 9 }, { reason: 'initial', in: 40, out: 0 }],
  cash: { sessions: [{ id: 3, zNumber: 'Z-20261031-0001', staffName: 'Sara', expected: 580.5, counted: 578.5, variance: -2 }], totalVariance: -2 },
};

function preview(over: Partial<DayPreview> = {}): DayPreview {
  return contract(DayPreviewSchema, {
    branchId: 1, day: TODAY, status: 'open', businessDayId: null, openCashSessions: [], monthClosed: false, report: REPORT, ...over,
  });
}

function kept(over: Partial<BusinessDayDetail> = {}): BusinessDayDetail {
  return contract(BusinessDayDetailSchema, {
    id: 7, branchId: 1, branchName: 'Home', day: TODAY, status: 'closed', dayNumber: 'DAY-20261031-0001',
    closedBy: 12, closedByName: 'Fiona', closedAt: CLOSED_AT, reopenedBy: null, reopenedByName: null, reopenedAt: null, reopenReason: null,
    report: REPORT, ...over,
  });
}

const SUMMARY = {
  branches: [
    { branchId: 1, branchName: 'Home', days: 26, sales: 9000, moneyIn: 9500, moneyOut: 4000, refunded: 100, cashVariance: -5 },
    { branchId: 2, branchName: 'Piassa', days: 20, sales: 4000, moneyIn: 4100, moneyOut: 500, refunded: 0, cashVariance: 0 },
  ],
  totals: { days: 46, sales: 13000, moneyIn: 13600, moneyOut: 4500, refunded: 100, cashVariance: -5 },
};

function monthPreview(over: Partial<MonthPreview> = {}): MonthPreview {
  return contract(MonthPreviewSchema, {
    month: '2026-09', status: 'open', businessMonthId: null, ended: true, openDays: [], summary: SUMMARY, ...over,
  });
}

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let today: 'open' | 'closed' | 'reopened';
let days: Record<string, DayPreview>;
let closedDays: BusinessDayDetail[];
let months: MonthPreview[];

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
    if (u.pathname === '/business-days/today') return json(contract(TodayStatusSchema, { branchId: 1, day: TODAY, status: today }));
    if (u.pathname === '/business-days/preview') {
      const day = u.searchParams.get('day')!;
      return json(contract(DayPreviewSchema, days[day] ?? preview({ day })));
    }
    if (u.pathname === '/business-days' && method === 'GET') {
      const items = closedDays.map(({ report: _r, ...d }) => d);
      return json(contract(BusinessDayListResponseSchema, { items }));
    }
    if (/^\/business-days\/\d+$/.test(u.pathname)) return json(contract(BusinessDayDetailSchema, closedDays.find((d) => d.id === Number(u.pathname.split('/')[2]))!));
    if (u.pathname === '/business-days/close') return json(contract(BusinessDayDetailSchema, kept({ day: body.day })), 201);
    if (/^\/business-days\/\d+\/reopen$/.test(u.pathname)) {
      return json(contract(BusinessDayDetailSchema, kept({ status: 'reopened', reopenedBy: 1, reopenedByName: 'Admin', reopenedAt: CLOSED_AT, reopenReason: body.reason })));
    }
    if (u.pathname === '/business-months' && method === 'GET') {
      const items = months.filter((m) => m.businessMonthId !== null).map((m) => ({
        id: m.businessMonthId!, month: m.month, status: m.status === 'open' ? 'closed' : m.status, closedBy: 12, closedByName: 'Fiona', closedAt: CLOSED_AT,
        reopenedBy: null, reopenedByName: null, reopenedAt: null, reopenReason: null,
      }));
      return json(contract(BusinessMonthListResponseSchema, { items }));
    }
    if (u.pathname === '/business-months/preview') {
      const month = u.searchParams.get('month')!;
      return json(contract(MonthPreviewSchema, months.find((m) => m.month === month) ?? monthPreview({ month, ended: month < TODAY.slice(0, 7) })));
    }
    const monthDetail = (over: object = {}) => contract(BusinessMonthDetailSchema, {
      id: 4, month: '2026-09', status: 'closed', closedBy: 12, closedByName: 'Fiona', closedAt: CLOSED_AT,
      reopenedBy: null, reopenedByName: null, reopenedAt: null, reopenReason: null, summary: SUMMARY, ...over,
    });
    if (/^\/business-months\/\d+$/.test(u.pathname)) return json(monthDetail());
    if (u.pathname === '/business-months/close') return json(monthDetail({ month: body.month }), 201);
    if (/^\/business-months\/\d+\/reopen$/.test(u.pathname)) {
      return json(monthDetail({ status: 'reopened', reopenedBy: 1, reopenedByName: 'Admin', reopenedAt: CLOSED_AT, reopenReason: body.reason }));
    }
    if (u.pathname === '/notifications/stream') return new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    if (u.pathname === '/notifications/unread-count') return json(contract(UnreadCountResponseSchema, { count: 2 }));
    if (u.pathname === '/notifications') {
      const note = (id: string, eventType: string, title: string, entityType: string, entityId: string) => contract(NotificationSchema, {
        id, branchId: 1, targetRoles: ['Super_Admin', 'Finance_Officer'], targetStaffId: null, eventType, title, body: 'reopened: A late sale',
        entityType, entityId, severity: 'warning', isRead: false, readAt: null, createdAt: new Date().toISOString(),
      });
      const data = [note('61', 'business_day.reopened', '🔓 Day reopened', 'business_day', '7'), note('62', 'business_month.reopened', '🔓 Month reopened', 'business_month', '4')];
      return json(contract(NotificationListResponseSchema, { data, total: 2, page: 1, pageSize: 50, totalPages: 1 }));
    }
    if (u.pathname.startsWith('/notifications/')) return json(contract(MarkReadResponseSchema, { success: true }));
    return json({ items: [] });
  }));
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

function show(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Manager']);
  today = 'open';
  days = {};
  closedDays = [];
  months = [];
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the Days tab (decisions 1a–3a)', () => {
  it("shows the month's calendar in the shop's days, today open and later days not yet", async () => {
    closedDays = [kept({ id: 6, day: '2026-10-30', dayNumber: 'DAY-20261030-0001' })];
    show(<DayClosePage />);
    expect(await screen.findByRole('button', { name: '2026-10-30 Closed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2026-10-31 Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2026-10-01 Open' })).toBeInTheDocument();
    await settle();
    expect(calls.some((c) => c.path === '/business-days?month=2026-10')).toBe(true);
  });

  it('opens a day with its report so far, and waits for its cash sessions', async () => {
    days[TODAY] = preview({ openCashSessions: [{ id: 3, staffName: 'Sara', status: 'open' }] });
    const user = show(<DayClosePage />);
    await user.click(await screen.findByRole('button', { name: '2026-10-31 Open' }));
    const panel = await screen.findByRole('region', { name: 'Day 2026-10-31' });
    for (const text of ['Orders', 'POS sales', 'Exchanges', 'Cash', 'Bank', 'Returns', 'Sale', 'Z-20261031-0001', 'Short ETB 2.00']) {
      expect(within(panel).getAllByText(text).length, text).toBeGreaterThan(0);
    }
    expect(within(panel).getByText('ETB 750.50')).toBeInTheDocument();
    expect(within(panel).getByText(/Close every cash session of the day first: Sara/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close day' })).toBeDisabled();
  });

  it('closes the day after a confirmation, and the report is kept', async () => {
    const user = show(<DayClosePage />);
    await user.click(await screen.findByRole('button', { name: '2026-10-31 Open' }));
    const panel = await screen.findByRole('region', { name: 'Day 2026-10-31' });
    await user.click(within(panel).getByRole('button', { name: 'Close day' }));
    const dialog = screen.getByRole('dialog', { name: 'Close 2026-10-31?' });
    expect(within(dialog).getByText(/nothing more can be recorded in this branch on that day/)).toBeInTheDocument();
    days[TODAY] = preview({ status: 'closed', businessDayId: 7 });
    closedDays = [kept()];
    await user.click(within(dialog).getByRole('button', { name: 'Close day' }));
    await waitFor(() => expect(posted('/business-days/close')).toEqual([{ day: TODAY }]));
    expect(await screen.findByText(/DAY-20261031-0001 · closed by Fiona/)).toBeInTheDocument();
  });

  it('prints a closed day\'s report with lines to sign', async () => {
    days[TODAY] = preview({ status: 'closed', businessDayId: 7 });
    closedDays = [kept()];
    const user = show(<DayClosePage />);
    await user.click(await screen.findByRole('button', { name: '2026-10-31 Closed' }));
    await user.click(await screen.findByRole('button', { name: '🖨 Print day report' }));
    const slip = screen.getByRole('dialog', { name: 'Day report DAY-20261031-0001' });
    for (const text of ['Home', 'Fiona', 'POS sales', 'Z-20261031-0001', 'Closed by', 'Checked by']) {
      expect(within(slip).getAllByText(new RegExp(text)).length, text).toBeGreaterThan(0);
    }
  });

  it('offers no close to a Sales account', async () => {
    me = profile(['Sales']);
    const user = show(<DayClosePage />);
    await user.click(await screen.findByRole('button', { name: '2026-10-31 Open' }));
    await screen.findByRole('region', { name: 'Day 2026-10-31' });
    expect(screen.queryByRole('button', { name: 'Close day' })).toBeNull();
  });

  it('lets an Admin reopen a closed day, with a reason and a warning (5a)', async () => {
    me = profile(['Admin'], 1);
    days[TODAY] = preview({ status: 'closed', businessDayId: 7 });
    closedDays = [kept()];
    const user = show(<DayClosePage initialContext={{ dayId: '7' }} />);
    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    const dialog = screen.getByRole('dialog', { name: 'Reopen 2026-10-31?' });
    expect(within(dialog).getByText(/its figures may change/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reopen' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason'), 'A late sale');
    await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(posted('/business-days/7/reopen')).toEqual([{ reason: 'A late sale' }]));
  });

  it('keeps Reopen from a Manager', async () => {
    days[TODAY] = preview({ status: 'closed', businessDayId: 7 });
    closedDays = [kept()];
    show(<DayClosePage initialContext={{ dayId: '7' }} />);
    expect(await screen.findByText(/DAY-20261031-0001 · closed by Fiona/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });
});

describe('the Months tab (decisions 4a, 5a)', () => {
  it('shows the days each branch still has to close, and keeps Close until they are', async () => {
    me = profile(['Finance_Officer'], 12);
    months = [monthPreview({ openDays: [{ branchId: 1, branchName: 'Home', days: ['2026-09-03'] }, { branchId: 2, branchName: 'Piassa', days: ['2026-09-04', '2026-09-05'] }] })];
    const user = show(<DayClosePage initialContext={{ tab: 'months' }} />);
    await user.click(await screen.findByRole('button', { name: '2026-09 Open' }));
    const panel = await screen.findByRole('region', { name: 'Month 2026-09' });
    expect(within(panel).getByText(/Piassa: 2026-09-04, 2026-09-05/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close month' })).toBeDisabled();
    // A day of this branch opens on the Days tab.
    await user.click(within(panel).getByRole('button', { name: '2026-09-03' }));
    expect(await screen.findByRole('region', { name: 'Day 2026-09-03' })).toBeInTheDocument();
  });

  it('closes an ended month with its summary, for a Finance_Officer', async () => {
    me = profile(['Finance_Officer'], 12);
    const user = show(<DayClosePage initialContext={{ tab: 'months' }} />);
    await user.click(await screen.findByRole('button', { name: '2026-09 Open' }));
    const panel = await screen.findByRole('region', { name: 'Month 2026-09' });
    expect(within(panel).getByText('Piassa')).toBeInTheDocument();
    expect(within(panel).getByText('ETB 13,000.00')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Close month' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Close 2026-09?' })).getByRole('button', { name: 'Close month' }));
    await waitFor(() => expect(posted('/business-months/close')).toEqual([{ month: '2026-09' }]));
  });

  it('keeps Close from a month not ended, and from a Manager', async () => {
    me = profile(['Finance_Officer'], 12);
    const user = show(<DayClosePage initialContext={{ tab: 'months' }} />);
    await user.click(await screen.findByRole('button', { name: '2026-10 Open' }));
    const panel = await screen.findByRole('region', { name: 'Month 2026-10' });
    expect(within(panel).getByText(/has not ended/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close month' })).toBeDisabled();
  });

  it('lets an Admin reopen a closed month with a reason', async () => {
    me = profile(['Admin'], 1);
    months = [monthPreview({ status: 'closed', businessMonthId: 4 })];
    const user = show(<DayClosePage initialContext={{ monthId: '4' }} />);
    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    const dialog = screen.getByRole('dialog', { name: 'Reopen 2026-09?' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Supplier invoice missed');
    await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(posted('/business-months/4/reopen')).toEqual([{ reason: 'Supplier invoice missed' }]));
  });

  it('shows a Manager the months without Close', async () => {
    const user = show(<DayClosePage initialContext={{ tab: 'months' }} />);
    await user.click(await screen.findByRole('button', { name: '2026-09 Open' }));
    await screen.findByRole('region', { name: 'Month 2026-09' });
    expect(screen.queryByRole('button', { name: 'Close month' })).toBeNull();
  });
});

describe('across the app (decisions 5a, 6a)', () => {
  it('says when the branch\'s day is closed, and nothing while it is open', async () => {
    today = 'closed';
    show(<ClosedDayBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent('Today (2026-10-31) is closed in this branch');
  });

  it('shows no banner on an open day', async () => {
    show(<ClosedDayBanner />);
    await settle();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is in the menu under Finance for Admin, Manager and Finance_Officer, not Sales or Super_Admin', () => {
    const finance = NAV_SECTIONS.find((s) => s.id === 'finance')!;
    expect(finance.items.map((i) => i.id)).toContain('day-close');
    expect(canOpenPage('day-close', 'Finance_Officer', ['Finance_Officer'], ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS', 'CLOSE_DAY', 'CLOSE_MONTH'])).toBe(true);
    expect(canOpenPage('day-close', 'Manager', ['Manager'], ['VIEW_REPORTS', 'CLOSE_DAY'])).toBe(true);
    expect(canOpenPage('day-close', 'Sales', ['Sales'], ['CREATE_SALE', 'PROCESS_PAYMENT'])).toBe(false);
    expect(canOpenPage('day-close', 'Super_Admin', ['Super_Admin'], ['VIEW_REPORTS', 'MANAGE_STAFF', 'MANAGE_BRANCH'])).toBe(false);
  });

  it('opens the day or the month from the reopen notification', async () => {
    const onNavigate = vi.fn();
    const user = show(<NotificationBell onNavigate={onNavigate} />);
    await user.click(await screen.findByRole('button', { name: 'Notifications (2 unread)' }));
    await user.click(await screen.findByText('🔓 Day reopened'));
    expect(onNavigate).toHaveBeenCalledWith('day-close', { dayId: '7' });
    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByText('🔓 Month reopened'));
    expect(onNavigate).toHaveBeenCalledWith('day-close', { monthId: '4' });
  });
});
