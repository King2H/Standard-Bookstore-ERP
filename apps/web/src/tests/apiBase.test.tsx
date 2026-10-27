// #23 (M6, step 2): every request goes through the shared client, to /api/v1
// on the API named by VITE_API_URL. Two places used to build their own
// requests and went wrong:
// - CSV exports called '/api/…' on the web app's own host, so a deployment
//   with the API elsewhere (DEPLOY.md, Render) saved index.html as the CSV;
// - the notification bell marked notifications read without the CSRF token,
//   so the API refused it and they came back unread after a reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const API = vi.hoisted(() => {
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  return 'https://api.example.test/api/v1';
});

import { api, setAccessToken, setCsrfToken } from '../lib/api.js';
import DashboardPage from '../features/dashboard/pages/DashboardPage.js';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { ToastProvider } from '../components/Toast.js';
import { emptyReport } from './reportFixtures.js';

// The dashboard's reports, empty (as in DashboardPage.inventoryAvailableStock.test.tsx).
const EMPTY_KPIS = {
  dailySales: 0, monthlySales: 0, dailyRevenue: 0, monthlyRevenue: 0, averageOrderValue: 0,
  totalActiveCustomers: 0, lowStockAlerts: 0, pendingOrders: 0, totalExchangesToday: 0,
  outstandingBalance: 0, netProfit: 0, fulfilledRevenue: 0, outstandingReceivables: 0,
  cashSalesRevenue: 0, creditSalesRevenue: 0, collectedCreditRevenue: 0, purchaseCost: 0,
  totalDiscounts: 0, grossProfit: 0, dailyNetProfit: 0, monthlyNetProfit: 0,
  dailyNetSalesRevenue: 0, monthlyNetSalesRevenue: 0, dailyNetProfitUnified: 0,
  monthlyNetProfitUnified: 0, dailyGrossMarginPct: 0, monthlyGrossMarginPct: 0,
  grossProfitUnified: 0, overdueReceivablesAmount: 0, inventoryValue: 0, inventoryInTransit: 0,
};

const EMPTY_INVENTORY = {
  summary: { totalBooks: 120, totalStockUnits: 940, availableStock: 875, reservedStock: 65, lowStockItems: 4, outOfStockItems: 1 },
  lowStockItems: [], topSellingBooks: [], stockMovement: [],
};

const EMPTY_PERIOD = {
  period: 'today', dateFrom: '', dateTo: '', netSales: 0, grossProfit: 0, grossMarginPct: 0,
  previous: { dateFrom: '', dateTo: '', netSales: 0, grossProfit: 0, grossMarginPct: 0 },
  netSalesChangePct: null, grossProfitChangePct: null, cashIn: 0, cashOut: 0, cashCollected: 0, previousCashCollected: 0,
};
const ME = {
  id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
  lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
  roles: [{ branchId: 1, branchName: 'Home', role: 'Manager' }], currentRole: 'Manager', currentRoles: ['Manager'],
  currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
};
function dashboardReport(url: string): unknown {
  const path = url.slice(API.length);
  if (path === '/staff/me') return ME;
  if (path.startsWith('/reports/kpis/period')) return EMPTY_PERIOD;
  if (path.startsWith('/reports/kpis')) return EMPTY_KPIS;
  if (path.startsWith('/reports/inventory')) return EMPTY_INVENTORY;
  return emptyReport(path) ?? { items: [] };
}

type Call = { url: string; method: string; headers: Record<string, string> };
let calls: Call[] = [];

/** Answers every request: JSON for reads, a CSV for exports, an empty notification stream. */
function stubFetch(json: (url: string) => unknown = () => ({ items: [] })) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string> });
    if (input.includes('/export')) return new Response('a,b\n1,2\n', { status: 200, headers: { 'Content-Type': 'text/csv' } });
    if (input.endsWith('/notifications/stream')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(json(input)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

beforeEach(() => {
  setAccessToken('token');
  setCsrfToken('csrf-1');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setCsrfToken(null);
});

describe('The API client', () => {
  it('calls /api/v1 on the API named by VITE_API_URL (was: the deprecated /api)', async () => {
    stubFetch(() => ({ ok: true }));
    await api.get('/health');
    expect(calls[0].url).toBe(`${API}/health`);
  });

  it('sends the CSRF token on changes, and not on reads', async () => {
    stubFetch(() => ({ ok: true }));
    await api.get('/suppliers');
    await api.put('/suppliers/1', {});
    expect(calls[0].headers['X-CSRF-Token']).toBeUndefined();
    expect(calls[1].headers['X-CSRF-Token']).toBe('csrf-1');
  });
});

describe('CSV exports', () => {
  it('download from the API, not from the web app\'s own host (was: /api/reports/… on the web host)', async () => {
    stubFetch(dashboardReport);
    renderWithProviders(<DashboardPage userRole="Manager" userRoles={['Manager']} userPermissions={['VIEW_REPORTS']} onNavigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: /^Export/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Sales' }));

    await waitFor(() => expect(calls.some(c => c.url.includes('/export'))).toBe(true));
    const exportCall = calls.find(c => c.url.includes('/export'))!;
    expect(exportCall.url).toMatch(new RegExp(`^${API.replace(/[.]/g, '\\.')}/reports/sales/export\\?`));
    expect(exportCall.url).toContain('format=csv');
    expect(exportCall.headers.Authorization).toBe('Bearer token');
  });
});

describe('The notification bell', () => {
  const unread = {
    id: '7', branchId: 1, targetRoles: ['Sales'], targetStaffId: null, eventType: 'order.created', title: 'New order', body: 'ORD-1',
    entityType: null, entityId: null, severity: 'info', isRead: false, readAt: null, createdAt: new Date().toISOString(),
  };
  // The bell reads who is signed in (for the branch), its list and the unread count.
  const bellAnswers = (url: string) => url.endsWith('/staff/me') ? { currentBranchId: 1 }
    : url.endsWith('/unread-count') ? { count: 1 }
    : { data: [unread], total: 1, page: 1, pageSize: 50, totalPages: 1 };

  it('marks a notification read with the CSRF token, so the API accepts it (was: 403 CSRF_INVALID)', async () => {
    stubFetch(bellAnswers);
    const { unmount } = renderWithProviders(<NotificationBell onNavigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await userEvent.click(await screen.findByText('New order'));

    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
    const put = calls.find(c => c.method === 'PUT')!;
    expect(put.url).toBe(`${API}/notifications/7/read`);
    expect(put.headers['X-CSRF-Token']).toBe('csrf-1');
    unmount();
  });

  it('marks them all read with the CSRF token', async () => {
    stubFetch(bellAnswers);
    const { unmount } = renderWithProviders(<NotificationBell onNavigate={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
    const put = calls.find(c => c.method === 'PUT')!;
    expect(put.url).toBe(`${API}/notifications/read-all`);
    expect(put.headers['X-CSRF-Token']).toBe('csrf-1');
    unmount();
  });
});
