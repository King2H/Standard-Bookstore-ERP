// Dashboard Standardization & Unified Reports Engine — UI test.
// Verifies the KPI grid is reorganized into a Primary (Financial Performance
// & Profitability) / Secondary (Cash Flow & Liquidity) / Tertiary
// (Operational & Inventory Controls) hierarchy, that the Primary row's
// Net Profit/Gross Profit/Net Sales Revenue cards render the new *Unified /
// netSalesRevenue KPI fields with bold/highlighted treatment, and that the
// superseded ambiguous cards (Monthly Sales, Today's Sales, Discount Total)
// are gone from the top-level grid.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from '../pages/DashboardPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  getAccessToken: () => 'test-token',
  getCurrentBranchId: () => 1,
}));

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
  procurementExpense: 9000,
  grossProfit: 60000,
  dailyNetProfit: 1000,
  monthlyNetProfit: 15000,
  // Dashboard Standardization & Unified Reports Engine fields
  dailyNetSalesRevenue: 3000,
  monthlyNetSalesRevenue: 120000,
  dailyNetProfitUnified: 2000,
  monthlyNetProfitUnified: 50000,
  grossProfitUnified: 75000,
  overdueReceivablesAmount: 1200,
};

const EMPTY_SALES = { summary: { totalSales: 0, totalOrders: 0, averageOrderValue: 0, totalPosSales: 0, totalPosTransactions: 0, totalDiscountAmount: 0, discountByType: { Normal: 0, Merchant: 0, Special: 0 } }, byPeriod: [], byBranch: [] };
const EMPTY_PAYMENTS = { summary: { totalCollected: 0, totalRefunded: 0, netCollected: 0, pendingPayments: 0 }, byMethod: [], byPeriod: [] };
const EMPTY_EXCHANGES = { summary: { totalExchanges: 0, totalIncomingValue: 0, totalOutgoingValue: 0, netExchangeImpact: 0 }, bySettlementType: [], byPeriod: [] };
const EMPTY_INVENTORY = { summary: { totalBooks: 0, totalStockUnits: 0, availableStock: 0, reservedStock: 0, lowStockItems: 0, outOfStockItems: 0 }, lowStockItems: [], topSellingBooks: [], stockMovement: [] };
const EMPTY_CUSTOMERS = { summary: { totalCustomers: 0, activeCustomers: 0, repeatCustomers: 0, newCustomersInPeriod: 0 }, topCustomers: [], byPeriod: [] };

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardPage userRole="Manager" onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/reports/kpis'))      return Promise.resolve(KPIS);
    if (path.startsWith('/reports/sales'))     return Promise.resolve(EMPTY_SALES);
    if (path.startsWith('/reports/payments'))  return Promise.resolve(EMPTY_PAYMENTS);
    if (path.startsWith('/reports/exchanges')) return Promise.resolve(EMPTY_EXCHANGES);
    if (path.startsWith('/reports/inventory')) return Promise.resolve(EMPTY_INVENTORY);
    if (path.startsWith('/reports/customers')) return Promise.resolve(EMPTY_CUSTOMERS);
    return Promise.resolve({ items: [] });
  });
});

describe('DashboardPage — KPI hierarchy (Dashboard Standardization & Unified Reports Engine)', () => {
  it('renders the three row headings in priority order: Financial Performance, Cash Flow, Operational', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Financial Performance & Profitability')).toBeInTheDocument());
    expect(screen.getByText('Cash Flow & Liquidity')).toBeInTheDocument();
    expect(screen.getByText('Operational & Inventory Controls')).toBeInTheDocument();
  });

  it('Primary row shows Net Profit (Today & Monthly), Gross Profit, and Net Sales Revenue from the unified KPI fields', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Net Profit')).toBeInTheDocument());
    expect(screen.getByText('ETB 2.0K')).toBeInTheDocument();   // dailyNetProfitUnified
    expect(screen.getByText('ETB 50.0K')).toBeInTheDocument();  // monthlyNetProfitUnified

    expect(screen.getByText('Gross Profit')).toBeInTheDocument();
    expect(screen.getByText('ETB 75.0K')).toBeInTheDocument();  // grossProfitUnified

    expect(screen.getByText('Net Sales Revenue')).toBeInTheDocument();
    expect(screen.getByText('ETB 120.0K')).toBeInTheDocument(); // monthlyNetSalesRevenue
    expect(screen.getByText(/Today: ETB 3,000\.00|Today: ETB 3\.0K/)).toBeInTheDocument();
  });

  it('Secondary row shows Cash Collected Today, Outstanding Receivables, and Overdue Receivables', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Cash Collected Today')).toBeInTheDocument());
    expect(screen.getByText('Outstanding Receivables')).toBeInTheDocument();
    expect(screen.getByText('Overdue Receivables')).toBeInTheDocument();
    expect(screen.getByText('ETB 1.2K')).toBeInTheDocument(); // overdueReceivablesAmount
  });

  it('Tertiary row shows Low Stock Alerts, Procurement Expense, and Pending Orders', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Low Stock Alerts')).toBeInTheDocument());
    expect(screen.getByText('Procurement Expense')).toBeInTheDocument();
    // "Pending Orders" also appears in the below-the-fold Alerts & Activity
    // panel (kpis.pendingOrders > 0 in this fixture) — assert at least the
    // KPI card instance exists rather than requiring a single match.
    expect(screen.getAllByText('Pending Orders').length).toBeGreaterThanOrEqual(1);
  });

  it('no longer renders the superseded Monthly Sales / Today\'s Sales / Discount Total cards', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Net Profit')).toBeInTheDocument());
    expect(screen.queryByText('Monthly Sales')).not.toBeInTheDocument();
    expect(screen.queryByText("Today's Sales")).not.toBeInTheDocument();
    expect(screen.queryByText('Discount Total')).not.toBeInTheDocument();
  });
});
