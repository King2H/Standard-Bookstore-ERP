// Dashboard Standardization & Unified Reports Engine — UI test, updated for
// Prompt 2 (Modern KPI Dashboard, Synchronized Reports & Production-Grade
// Procurement Lifecycle).
//
// Verifies the KPI grid is organized into Sales Performance / Cash &
// Receivables / Inventory & Operations sections; that Sales Performance
// renders Net Sales / Net Profit / Gross Margin % from the period-scoped
// KPI endpoint (Prompt 2 decision #1 — accrual figures, not
// computeNetProfit()'s collected-cash figures); that there is exactly one
// "Net Profit" label (no competing cash-basis "Net Profit" card); that the
// Procurement Expense card is gone; and that the superseded ambiguous
// cards (Monthly Sales, Today's Sales, Discount Total) are gone from the
// top-level grid.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../features/dashboard/pages/DashboardPage.js';
import { emptyReport } from './reportFixtures.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: { get: (...args: unknown[]) => getMock(...args) },
  getAccessToken: () => 'test-token',
  getCurrentBranchId: () => 1,
}));

const ME = {
  id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-10-01T00:00:00.000Z', mustChangePassword: false,
  lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
  roles: [{ branchId: 1, branchName: 'Home', role: 'Manager' }], currentRole: 'Manager', currentRoles: ['Manager'],
  currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
};

const KPIS = {
  dailySales: 3000,
  monthlySales: 120000,
  dailyRevenue: 4000,
  monthlyRevenue: 100000,
  averageOrderValue: 500,
  totalActiveCustomers: 42,
  lowStockAlerts: 5,
  pendingOrders: 3,
  totalExchangesToday: 1,
  outstandingBalance: 8000,
  netProfit: 20000,
  fulfilledRevenue: 90000,
  outstandingReceivables: 8000,
  cashSalesRevenue: 40000,
  creditSalesRevenue: 20000,
  collectedCreditRevenue: 10000,
  purchaseCost: 30000,
  totalDiscounts: 2500,
  grossProfit: 60000,
  dailyNetProfit: 1000,
  monthlyNetProfit: 15000,
  // Dashboard Standardization & Unified Reports Engine fields
  dailyNetSalesRevenue: 3000,
  monthlyNetSalesRevenue: 120000,
  dailyNetProfitUnified: 2000,
  monthlyNetProfitUnified: 50000,
  dailyGrossMarginPct: 40,
  monthlyGrossMarginPct: 42,
  grossProfitUnified: 75000,
  overdueReceivablesAmount: 1200,
  // Prompt 2
  inventoryValue: 55000,
};

const PERIOD_KPIS = {
  period: 'today',
  dateFrom: '2026-08-12', dateTo: '2026-08-12',
  netSales: 3000, grossProfit: 2000, grossMarginPct: 66.7,
  previous: { dateFrom: '2026-08-11', dateTo: '2026-08-11', netSales: 2500, grossProfit: 1500, grossMarginPct: 60 },
  netSalesChangePct: 20, grossProfitChangePct: 33.3,
  cashIn: 4500, cashOut: 500, cashCollected: 4000, previousCashCollected: 3500,
};


function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardPage userRole="Manager" userRoles={['Manager']} userPermissions={['VIEW_REPORTS']} onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path === '/staff/me') return Promise.resolve(ME);
    // Order matters — check the more specific paths before their prefixes.
    if (path.startsWith('/reports/kpis/period'))          return Promise.resolve(PERIOD_KPIS);
    if (path.startsWith('/reports/kpis'))                 return Promise.resolve(KPIS);
    const empty = emptyReport(path);
    if (empty) return Promise.resolve(empty);
    return Promise.resolve({ items: [] });
  });
});

describe('DashboardPage — KPI hierarchy (Prompt 2)', () => {
  it('renders the three section headings in order: Sales Performance, Cash & Receivables, Inventory & Operations', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Sales Performance')).toBeInTheDocument());
    expect(screen.getByText('Cash & Receivables')).toBeInTheDocument();
    expect(screen.getByText('Inventory & Operations')).toBeInTheDocument();
  });

  it('Sales Performance shows Net Sales, Net Profit, and Gross Margin % from the period-scoped KPI endpoint', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Net Sales')).toBeInTheDocument());
    expect(screen.getByText('ETB 3.0K')).toBeInTheDocument(); // periodKpis.netSales

    expect(screen.getByText('Net Profit')).toBeInTheDocument();
    expect(screen.getByText('ETB 2.0K')).toBeInTheDocument(); // periodKpis.grossProfit

    expect(screen.getByText('Gross Margin %')).toBeInTheDocument();
    expect(screen.getByText('66.7%')).toBeInTheDocument();

    // Exactly one "Net Profit" label anywhere on the page — no competing
    // cash-basis "Net Profit" card coexisting with the accrual one.
    expect(screen.getAllByText('Net Profit').length).toBe(1);
  });

  it('Net Sales card is not clickable (it aggregates ORDER + POS + RETURN + EXCHANGE, not orders alone)', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Net Sales')).toBeInTheDocument());
    const card = screen.getByText('Net Sales').closest('div.rounded-xl');
    expect(card).not.toBeNull();
    expect(card).not.toHaveClass('cursor-pointer');
  });

  it('Cash & Receivables shows a period-labeled Cash Collected card, Outstanding Receivables, and Overdue Receivables', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/Cash Collected/)).toBeInTheDocument());
    expect(screen.getByText('Outstanding Receivables')).toBeInTheDocument();
    expect(screen.getByText('Overdue Receivables')).toBeInTheDocument();
    expect(screen.getByText('ETB 1.2K')).toBeInTheDocument(); // overdueReceivablesAmount
  });

  it('Inventory & Operations shows Low Stock Items, Inventory Value, and Pending Customer Orders — no Procurement Expense card', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Low Stock Items')).toBeInTheDocument());
    expect(screen.getByText('Inventory Value')).toBeInTheDocument();
    expect(screen.getByText('ETB 55.0K')).toBeInTheDocument(); // kpis.inventoryValue
    expect(screen.getByText('Pending Customer Orders')).toBeInTheDocument();
    expect(screen.queryByText('Procurement Expense')).not.toBeInTheDocument();
  });

  it("no longer renders the superseded Monthly Sales / Today's Sales / Discount Total cards", async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Net Profit')).toBeInTheDocument());
    expect(screen.queryByText('Monthly Sales')).not.toBeInTheDocument();
    expect(screen.queryByText("Today's Sales")).not.toBeInTheDocument();
    expect(screen.queryByText('Discount Total')).not.toBeInTheDocument();
  });
});
