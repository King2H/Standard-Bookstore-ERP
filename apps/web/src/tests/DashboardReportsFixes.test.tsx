// #230 (#225 K5, K6, K7; owner decisions 3a, 4a, 2026-11-04): the dashboard
// shows stock needing attention once, low and out apart (was: four places,
// four answers, out counted as low); Payment Methods follows the selected
// period as Cash Collected does (was: every day, under "Today"); chart axes
// read small amounts as they are (was: "0K"). Every mocked answer is checked
// against its contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  InventoryReportSchema, KpiReportSchema, PaymentReportSchema, PeriodKpisSchema, ProfileResponseSchema,
  type KpiPeriod, type KpiReport,
} from '@bms/shared';
import DashboardPage from '../features/dashboard/pages/DashboardPage.js';
import { axisAmount } from '../features/dashboard/components/charts.js';
import { contract } from './contract.js';
import { EMPTY_REPORTS, emptyReport } from './reportFixtures.js';

// The Payment Methods chart is drawn (it has a method); jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const getMock = vi.fn();
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: { get: (...args: unknown[]) => getMock(...args) },
  getAccessToken: () => 'test-token',
  getCurrentBranchId: () => 1,
}));

const ME = contract(ProfileResponseSchema, {
  id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
  lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
  roles: [{ branchId: 1, branchName: 'Home', role: 'Manager' }], currentRole: 'Manager', currentRoles: ['Manager'],
  currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
});

const KPIS: KpiReport = contract(KpiReportSchema, {
  dailySales: 0, monthlySales: 0, dailyRevenue: 0, monthlyRevenue: 0, averageOrderValue: 0, totalActiveCustomers: 0,
  lowStockItems: 1, outOfStockItems: 2, pendingOrders: 0, totalExchangesToday: 0, outstandingBalance: 0,
  dailyNetSalesRevenue: 0, monthlyNetSalesRevenue: 0, dailyNetProfitUnified: 0, monthlyNetProfitUnified: 0,
  dailyGrossMarginPct: 0, monthlyGrossMarginPct: 0, grossProfitUnified: 0, overdueReceivablesAmount: 0,
  inventoryValue: 0, inventoryInTransit: 0,
});

const RANGES: Record<KpiPeriod, [string, string]> = {
  today: ['2026-11-04', '2026-11-04'], week: ['2026-11-02', '2026-11-04'], month: ['2026-11-01', '2026-11-04'], year: ['2026-01-01', '2026-11-04'],
};
const period = (p: KpiPeriod) => contract(PeriodKpisSchema, {
  period: p, dateFrom: RANGES[p][0], dateTo: RANGES[p][1], netSales: 0, grossProfit: 0, grossMarginPct: 0,
  previous: { dateFrom: '2026-01-01', dateTo: '2026-01-01', netSales: 0, grossProfit: 0, grossMarginPct: 0 },
  netSalesChangePct: null, grossProfitChangePct: null, cashIn: 0, cashOut: 0, cashCollected: 0, previousCashCollected: 0,
});

const INVENTORY = contract(InventoryReportSchema, {
  ...EMPTY_REPORTS.inventory,
  summary: { ...EMPTY_REPORTS.inventory.summary, lowStockItems: 1, outOfStockItems: 2 },
  stockAlerts: [
    { bookId: 1, title: 'Dune', locationId: 7, locationName: 'Main Floor', quantity: 0, reorderPoint: 5, status: 'out' },
    { bookId: 2, title: 'Oromay', locationId: 7, locationName: 'Main Floor', quantity: 2, reorderPoint: 5, status: 'low' },
  ],
});

const PAYMENTS = contract(PaymentReportSchema, {
  summary: { totalCollected: 50, totalRefunded: 0, netCollected: 50, pendingPayments: 0 },
  byMethod: [{ method: 'cash', total: 50, count: 1 }], byPeriod: [],
});

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path === '/staff/me') return Promise.resolve(ME);
    if (path.startsWith('/reports/kpis/period')) return Promise.resolve(period(new URLSearchParams(path.split('?')[1]).get('period') as KpiPeriod));
    if (path.startsWith('/reports/kpis')) return Promise.resolve(KPIS);
    if (path.startsWith('/reports/inventory')) return Promise.resolve(INVENTORY);
    if (path.startsWith('/reports/payments')) return Promise.resolve(PAYMENTS);
    const empty = emptyReport(path);
    if (empty) return Promise.resolve(empty);
    return Promise.resolve({ items: [] });
  });
});

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DashboardPage userRole="Manager" userRoles={['Manager']} userPermissions={['VIEW_REPORTS']} onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('Stock on the dashboard (#230, K5)', () => {
  it('shows one stock card, low and out apart (was: "Low Stock Items" counting books with none left)', async () => {
    renderDashboard();
    const card = (await screen.findByText('Stock Alerts')).closest('div.rounded-xl') as HTMLElement;
    expect(card).toHaveTextContent('Low 1 · Out 2');
    expect(screen.queryByText('Low Stock Items')).not.toBeInTheDocument();
  });

  it('lists each book once, marked Low or Out, and nowhere else (was: two lists and two tiles)', async () => {
    renderDashboard();
    const dune = (await screen.findByText('Dune')).closest('div') as HTMLElement;
    expect(within(dune).getByText('Out')).toBeInTheDocument();
    expect(within((screen.getByText('Oromay')).closest('div') as HTMLElement).getByText('Low · 2 left')).toBeInTheDocument();
    expect(screen.getAllByText('Dune')).toHaveLength(1);
    expect(screen.queryByText('Low Stock Alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('Out of Stock')).not.toBeInTheDocument();
  });
});

describe('Payment Methods (#230, K7)', () => {
  const paymentCalls = () => getMock.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/reports/payments'));

  it('counts the selected period, as Cash Collected does (was: every day, under "Today")', async () => {
    const user = renderDashboard();
    expect(await screen.findByText('Payment Methods · Today')).toBeInTheDocument();
    await waitFor(() => expect(paymentCalls().some((p) => p.includes('dateFrom=2026-11-04') && p.includes('dateTo=2026-11-04'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(await screen.findByText('Payment Methods · Month')).toBeInTheDocument();
    await waitFor(() => expect(paymentCalls().some((p) => p.includes('dateFrom=2026-11-01') && p.includes('dateTo=2026-11-04'))).toBe(true));
  });
});

describe('Chart axes (#230, K6)', () => {
  it('read small amounts as they are, then in K and M (was: "0K" below 1,000)', () => {
    expect([0, 250, 999, 1000, 1500, 25_000, 2_000_000, -500].map(axisAmount)).toEqual(['0', '250', '999', '1K', '1.5K', '25K', '2M', '-500']);
  });
});
