// #23 (M6, step 4): Dashboard part 1 moves the frame and the Live Overview to
// features/dashboard. The page follows every role held that reads reports;
// only staff with access to all branches pick a branch, starting on all
// (owner decision 3a); a date range out of order is not sent; quick actions
// follow the route guard; Cash Collected opens Payments History on its period
// (2a); amounts are in the shop's currency. Part 2 moves the report sections:
// the Discount Summary by preset type (1a), Top Selling Books said to be POS
// (2a), days in the reader's calendar, method names, no stray 0. Report
// answers the page reads are checked against their contracts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cloneElement, type ReactElement } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  InventoryReportSchema, KpiReportSchema, PaymentListResponseSchema, PaymentReportSchema, PeriodKpisSchema,
  ProfileResponseSchema, SalesReportSchema,
  type InventoryReport, type KpiReport, type PaymentReport, type ProfileResponse, type SalesReport,
} from '@bms/shared';
import DashboardPage from '../features/dashboard/pages/DashboardPage.js';
import PaymentsPage from '../features/payments/pages/PaymentsPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';
import { EMPTY_REPORTS, emptyReport } from './reportFixtures.js';

// jsdom has no layout, so a ResponsiveContainer measures 0 and draws nothing:
// give the charts a size, so their axes and legends can be read.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 200 }),
  };
});

const CREATED = '2026-10-18T07:00:00.000Z';

function profile(roles: string[], isAllBranches = false): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const ZERO_KPIS = Object.fromEntries(Object.keys(KpiReportSchema.shape).map((k) => [k, 0])) as KpiReport;
const KPIS = contract(KpiReportSchema, { ...ZERO_KPIS, outstandingBalance: 8000, overdueReceivablesAmount: 1200, lowStockAlerts: 2, pendingOrders: 1 });
const PERIOD = contract(PeriodKpisSchema, {
  period: 'today', dateFrom: '2026-10-20', dateTo: '2026-10-20', netSales: 3000, grossProfit: 2000, grossMarginPct: 66.7,
  previous: { dateFrom: '2026-10-19', dateTo: '2026-10-19', netSales: 2500, grossProfit: 1500, grossMarginPct: 60 },
  netSalesChangePct: 20, grossProfitChangePct: 33.3, cashCollected: 4000, previousCashCollected: 3500,
});
const INVENTORY = contract(InventoryReportSchema, {
  summary: { totalBooks: 1, totalStockUnits: 9, availableStock: 9, reservedStock: 0, lowStockItems: 2, outOfStockItems: 0 },
  lowStockItems: [], topSellingBooks: [], stockMovement: [],
});
const SALES = EMPTY_REPORTS.sales;
const PAYMENTS = EMPTY_REPORTS.payments;

type Call = { method: string; path: string };
let calls: Call[];
let me: ProfileResponse;
let currency: string;
let exportFails: boolean;
let sales: SalesReport | null;
let payments: PaymentReport;
let inventory: InventoryReport;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    const p = u.pathname;
    if (p === '/staff/me') return json(me);
    if (p === '/config/currency') return json({ currency });
    if (p === '/branches') {
      return json({ items: [1, 2].map((id) => ({ id, name: id === 1 ? 'Head Office' : 'Piassa', address: 'Addis Ababa', contactInfo: {}, operatingHours: {}, isActive: true, createdAt: CREATED })), total: 2, page: 1, pageSize: 100, totalPages: 1 });
    }
    if (p.endsWith('/export')) return exportFails ? json({ error: 'X', message: 'no', details: {} }, 500) : new Response('a\n1\n', { status: 200 });
    if (p === '/reports/kpis/period') return json(PERIOD);
    if (p === '/reports/kpis') return json(KPIS);
    if (p === '/reports/inventory') return json(inventory);
    if (p === '/reports/sales') return sales ? json(sales) : json({ error: 'X', message: 'no', details: {} }, 500);
    if (p === '/reports/payments') return json(payments);
    const empty = emptyReport(p);
    if (empty) return json(empty);
    if (p === '/payments') return json(contract(PaymentListResponseSchema, { items: [], total: 0, page: 1, totalPages: 0 }));
    return json({ items: [], total: 0, page: 1, totalPages: 0 });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const reportCalls = () => calls.filter((c) => c.path.startsWith('/reports/')).map((c) => c.path);

const PERMS: Record<string, string[]> = {
  Sales: ['CREATE_SALE', 'PROCESS_PAYMENT'],
  Manager: ['CREATE_SALE', 'PROCESS_PAYMENT', 'PROCESS_REFUND', 'APPROVE_EXCHANGE', 'MANAGE_INVENTORY', 'VIEW_REPORTS', 'MANAGE_STAFF'],
  Finance_Officer: ['PROCESS_PAYMENT', 'PROCESS_REFUND', 'VIEW_REPORTS'],
  Admin: ['CREATE_SALE', 'PROCESS_PAYMENT', 'PROCESS_REFUND', 'APPROVE_EXCHANGE', 'ADJUST_PRICE', 'MANAGE_INVENTORY', 'VIEW_REPORTS', 'MANAGE_STAFF', 'MANAGE_BRANCH'],
};

async function openDashboard(onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const perms = [...new Set(me.currentRoles.flatMap((r) => PERMS[r] ?? []))];
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><DashboardPage userRole={me.currentRole} userRoles={me.currentRoles} userPermissions={perms} onNavigate={onNavigate} /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  return { user: userEvent.setup(), onNavigate };
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Manager']);
  currency = 'ETB';
  exportFails = false;
  sales = SALES;
  payments = PAYMENTS;
  inventory = INVENTORY;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('who sees it', () => {
  it('follows every role held (was: the main role, so Sales + Finance_Officer was turned away)', async () => {
    me = profile(['Sales', 'Finance_Officer']);
    await openDashboard();
    expect(await screen.findByText('Sales Performance')).toBeInTheDocument();
    expect(screen.queryByText(/Dashboard is available to/)).not.toBeInTheDocument();
  });

  it('is not shown, and asks for no report, without a role that reads reports', async () => {
    me = profile(['Sales']);
    await openDashboard();
    expect(await screen.findByText(/Dashboard is available to/)).toBeInTheDocument();
    expect(reportCalls()).toEqual([]);
  });

  it('offers only the quick actions whose page one may open (was: all four for everyone)', async () => {
    me = profile(['Finance_Officer']);
    await openDashboard();
    await screen.findByText('Sales Performance');
    // The route guard's rule: no POS for a Finance_Officer; Procurement, Customers and Payments are theirs.
    expect(screen.queryByRole('button', { name: /New Sale/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New Purchase|Add Customer|Record Payment/ })).toHaveLength(3);
  });
});

describe('the branch', () => {
  it('is the session\'s for an Admin without access to all branches: no picker, no branch sent (was: "All Branches", then 403s)', async () => {
    me = profile(['Admin']);
    await openDashboard();
    await screen.findByText('Sales Performance');
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'All Branches' })).not.toBeInTheDocument();
    expect(reportCalls().length).toBeGreaterThan(0);
    expect(reportCalls().every((p) => !p.includes('branchId'))).toBe(true);
  });

  it('can be picked with access to all branches, starting on all of them (decision 3a; was: no picker for a Manager)', async () => {
    me = profile(['Manager'], true);
    const { user } = await openDashboard();
    await screen.findByText('Sales Performance');
    const picker = screen.getByLabelText('Branch') as HTMLSelectElement;
    expect(picker.value).toBe('');
    await screen.findByRole('option', { name: 'Piassa' });
    await user.selectOptions(picker, '2');
    await waitFor(() => expect(reportCalls().some((p) => p.startsWith('/reports/kpis?') && p.includes('branchId=2'))).toBe(true));
  });
});

describe('filters and actions', () => {
  it('do not send a date range out of order (was: every section failed without a word)', async () => {
    const { user } = await openDashboard();
    await screen.findByText('Sales Performance');
    await user.type(screen.getByLabelText('From'), '2026-10-20');
    await user.type(screen.getByLabelText('To'), '2026-10-01');
    expect(await screen.findByRole('alert')).toHaveTextContent('The start date is after the end date');
    await settle();
    expect(reportCalls().some((p) => p.includes('dateTo=2026-10-01'))).toBe(false);

    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-10-31');
    await waitFor(() => expect(reportCalls().some((p) => p.includes('dateFrom=2026-10-20') && p.includes('dateTo=2026-10-31'))).toBe(true));
  });

  it('say so in the app when an export fails (was: the browser\'s alert box)', async () => {
    exportFails = true;
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user } = await openDashboard();
    await user.click(await screen.findByRole('button', { name: /^Export/ }));
    await user.click(screen.getByRole('button', { name: 'Sales' }));
    expect(await screen.findByText('Export failed')).toBeInTheDocument();
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('show amounts in the shop\'s currency (was: always ETB)', async () => {
    currency = 'USD';
    await openDashboard();
    expect(await screen.findByText('USD 3.0K')).toBeInTheDocument();
    expect(screen.queryByText('ETB 3.0K')).not.toBeInTheDocument();
  });
});

describe('drill-downs', () => {
  it('leave the branch to the session, and Cash Collected opens Payments History on its period (decision 2a)', async () => {
    const { user, onNavigate } = await openDashboard();
    await user.click(await screen.findByText('Outstanding Receivables'));
    await user.click(screen.getByText(/^Cash Collected/));
    expect(onNavigate.mock.calls).toEqual([
      ['receivables', { status: 'Pending,PartiallyPaid,Overdue' }],
      ['payments', { tab: 'history', dateFrom: '2026-10-20', dateTo: '2026-10-20' }],
    ]);
  });

  it('Payments History takes the period and shows it as a filter to clear (was: the dates were dropped)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider><PaymentsPage initialContext={{ tab: 'history', dateFrom: '2026-10-01', dateTo: '2026-10-20' }} /></ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('2026-10-01 to 2026-10-20')).toBeInTheDocument();
    const history = () => calls.filter((c) => c.path.startsWith('/payments?')).map((c) => c.path);
    expect(history().some((p) => p.includes('dateFrom=2026-10-01') && p.includes('dateTo=2026-10-20'))).toBe(true);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear dates' }));
    await waitFor(() => expect(history().some((p) => !p.includes('dateFrom'))).toBe(true));
  });
});

describe('report sections', () => {
  const header = (title: string) => screen.getByRole('heading', { name: title }).parentElement!;
  const section = async (title: string) => (await screen.findByRole('heading', { name: title })).parentElement!.parentElement!;

  it('show discounts by preset type (decision 1a; was: never shown, its fields were not in the report)', async () => {
    sales = contract(SalesReportSchema, {
      ...SALES, summary: { ...SALES.summary, discounts: 100, discountsByType: { Normal: 60, Merchant: 30, Special: 10 } },
    });
    await openDashboard();
    const discounts = within(await section('Discount Summary'));
    expect(discounts.getByText('60.0%')).toBeInTheDocument();
    expect(discounts.getByText('30.0%')).toBeInTheDocument();
    expect(discounts.getByText('10.0%')).toBeInTheDocument();
  });

  it('show amounts and chart legends in the shop\'s currency (was: always ETB)', async () => {
    currency = 'USD';
    sales = contract(SalesReportSchema, {
      ...SALES, summary: { ...SALES.summary, totalPosSales: 2600 },
      byPeriod: [{ period: '2026-10-20 00:00:00+00', totalSales: 1000, totalOrders: 2, averageOrderValue: 500 }],
    });
    await openDashboard();
    expect(await screen.findByText('USD 2.6K')).toBeInTheDocument();
    expect(screen.getByText('Order Sales (USD)')).toBeInTheDocument();
    expect(screen.queryByText(/ETB/)).not.toBeInTheDocument();
  });

  it('label a period by its day in the reader\'s calendar (was: a day early west of UTC)', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      sales = contract(SalesReportSchema, {
        ...SALES, byPeriod: [{ period: '2026-10-20 00:00:00+00', totalSales: 1000, totalOrders: 2, averageOrderValue: 500 }],
      });
      await openDashboard();
      const trend = within(await section('Sales Trend'));
      expect((await trend.findAllByText('Oct 20')).length).toBeGreaterThan(0);
      expect(trend.queryByText('Oct 19')).not.toBeInTheDocument();
    } finally {
      process.env.TZ = tz;
    }
  });

  it('name payment methods as the rest of the app does (was: raw codes such as "cash")', async () => {
    payments = contract(PaymentReportSchema, {
      ...PAYMENTS,
      byMethod: [
        { method: 'cash', total: 500, count: 2 }, { method: 'bank', total: 300, count: 1 }, { method: 'loyalty_points', total: 20, count: 1 },
      ],
    });
    await openDashboard();
    expect(await screen.findByText('Bank Transfer')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Loyalty')).toBeInTheDocument();
    expect(screen.queryByText('cash')).not.toBeInTheDocument();
  });

  it('say that the top selling books are counter sales (decision 2a)', async () => {
    inventory = contract(InventoryReportSchema, { ...INVENTORY, topSellingBooks: [{ bookId: 1, title: 'Fikir Eske Mekabir', unitsSold: 3, revenue: 900 }] });
    await openDashboard();
    expect(await screen.findByText('Top Selling Books (POS)')).toBeInTheDocument();
  });

  it('print no stray 0 beside a title while a report loads or fails (was: "Sales Trend0")', async () => {
    sales = null;
    await openDashboard();
    await waitFor(() => expect(screen.getAllByText('Failed to load data').length).toBeGreaterThan(0));
    expect(header('Sales Trend').textContent).toBe('Sales Trend');
  });
});
