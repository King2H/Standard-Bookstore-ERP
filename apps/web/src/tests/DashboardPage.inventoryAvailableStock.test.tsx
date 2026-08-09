// Bug fix: reports.service.ts's getInventoryReport() has always computed
// and returned summary.availableStock/summary.reservedStock, but
// DashboardPage.tsx's InventoryReport interface never declared them, so
// the Inventory Insights panel silently dropped both fields instead of
// showing available stock. Locks in that the panel now renders them.
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

const EMPTY_KPIS = {
  dailySales: 0, monthlySales: 0, dailyRevenue: 0, monthlyRevenue: 0, averageOrderValue: 0,
  totalActiveCustomers: 0, lowStockAlerts: 0, pendingOrders: 0, totalExchangesToday: 0,
  outstandingBalance: 0, netProfit: 0, fulfilledRevenue: 0, outstandingReceivables: 0,
  cashSalesRevenue: 0, creditSalesRevenue: 0, collectedCreditRevenue: 0, purchaseCost: 0,
  totalDiscounts: 0, procurementExpense: 0, grossProfit: 0, dailyNetProfit: 0, monthlyNetProfit: 0,
  dailyNetSalesRevenue: 0, monthlyNetSalesRevenue: 0, dailyNetProfitUnified: 0,
  monthlyNetProfitUnified: 0, grossProfitUnified: 0, overdueReceivablesAmount: 0,
};
const EMPTY_SALES = { summary: { totalSales: 0, totalOrders: 0, averageOrderValue: 0, totalPosSales: 0, totalPosTransactions: 0, totalDiscountAmount: 0, discountByType: { Normal: 0, Merchant: 0, Special: 0 } }, byPeriod: [], byBranch: [] };
const EMPTY_PAYMENTS = { summary: { totalCollected: 0, totalRefunded: 0, netCollected: 0, pendingPayments: 0 }, byMethod: [], byPeriod: [] };
const EMPTY_EXCHANGES = { summary: { totalExchanges: 0, totalIncomingValue: 0, totalOutgoingValue: 0, netExchangeImpact: 0 }, bySettlementType: [], byPeriod: [] };
const EMPTY_CUSTOMERS = { summary: { totalCustomers: 0, activeCustomers: 0, repeatCustomers: 0, newCustomersInPeriod: 0 }, topCustomers: [], byPeriod: [] };

const INVENTORY_WITH_STOCK = {
  summary: { totalBooks: 120, totalStockUnits: 940, availableStock: 875, reservedStock: 65, lowStockItems: 4, outOfStockItems: 1 },
  lowStockItems: [], topSellingBooks: [], stockMovement: [],
};

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
    if (path.startsWith('/reports/kpis'))      return Promise.resolve(EMPTY_KPIS);
    if (path.startsWith('/reports/sales'))     return Promise.resolve(EMPTY_SALES);
    if (path.startsWith('/reports/payments'))  return Promise.resolve(EMPTY_PAYMENTS);
    if (path.startsWith('/reports/exchanges')) return Promise.resolve(EMPTY_EXCHANGES);
    if (path.startsWith('/reports/inventory')) return Promise.resolve(INVENTORY_WITH_STOCK);
    if (path.startsWith('/reports/customers')) return Promise.resolve(EMPTY_CUSTOMERS);
    return Promise.resolve({ items: [] });
  });
});

describe('Dashboard — Inventory Insights panel shows Available and Reserved stock', () => {
  it('renders Available and Reserved tiles with the values from GET /reports/inventory', async () => {
    renderDashboard();

    await waitFor(() => expect(screen.getByText('Available')).toBeInTheDocument());
    expect(screen.getByText('875')).toBeInTheDocument();

    expect(screen.getByText('Reserved')).toBeInTheDocument();
    expect(screen.getByText('65')).toBeInTheDocument();

    // Pre-existing tiles still present alongside the new ones.
    expect(screen.getByText('Books')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Units')).toBeInTheDocument();
    expect(screen.getByText('940')).toBeInTheDocument();
  });
});
