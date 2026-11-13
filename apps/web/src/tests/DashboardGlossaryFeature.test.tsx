// #268 (owner decision a, 2026-11-12): every figure of the dashboard's
// sections says under it, in plain words, what it counts, and the same
// figure reads the same everywhere: one glossary (features/dashboard/
// glossary.ts). The line is the figure's description, so it is read with it.
// Before, the sections' figures had a bare label (the top cards had a line).
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CustomerReportSchema, ExchangeReportSchema, InventoryReportSchema, PaymentReportSchema, PeriodKpisSchema, SalesReportSchema,
} from '@bms/shared';
import { SalesTrend, DiscountSummary } from '../features/dashboard/components/SalesSections.js';
import { PaymentMethods, ExchangeActivity } from '../features/dashboard/components/MoneySections.js';
import { InventoryInsights, CustomerInsights } from '../features/dashboard/components/StockCustomerSections.js';
import { GLOSSARY, type FigureLabel } from '../features/dashboard/glossary.js';
import { contract } from './contract.js';
import { EMPTY_REPORTS } from './reportFixtures.js';

const getMock = vi.fn();
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: { get: (...args: unknown[]) => getMock(...args) },
}));

beforeAll(() => {
  // The sections draw charts; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

// Every block of figures shown: a sale with a service, tax, binding and cash differences, discounts.
const SALES = contract(SalesReportSchema, {
  ...EMPTY_REPORTS.sales,
  summary: {
    ...EMPTY_REPORTS.sales.summary, totalSales: 460, totalOrders: 2, averageOrderValue: 230, totalPosSales: 115, netSales: 575,
    taxIncluded: 75, netSalesBeforeTax: 500, bookSales: 455, serviceIncome: 120, grossProfit: 300, bindingCostDifference: 15,
    cashOverShort: -2, netProfit: 283, discounts: 30, discountsByType: { Normal: 10, Merchant: 15, Special: 5 },
  },
  byPeriod: [{ period: '2026-11-12', totalSales: 460, totalOrders: 2, averageOrderValue: 230 }],
});
const PAYMENTS = contract(PaymentReportSchema, {
  summary: { totalCollected: 575, totalRefunded: 20, netCollected: 555, pendingPayments: 0 }, byMethod: [{ method: 'cash', total: 575, count: 3 }], byPeriod: [],
});
const EXCHANGES = contract(ExchangeReportSchema, {
  summary: { totalExchanges: 1, totalIncomingValue: 100, totalOutgoingValue: 115, netExchangeImpact: 15 }, bySettlementType: [], byPeriod: [],
});
const INVENTORY = contract(InventoryReportSchema, {
  summary: { totalBooks: 3, totalStockUnits: 40, availableStock: 40, reservedStock: 2, lowStockItems: 0, outOfStockItems: 0 },
  stockAlerts: [], topSellingBooks: [], stockMovement: [],
});
const CUSTOMERS = contract(CustomerReportSchema, {
  summary: { totalCustomers: 30, activeCustomers: 28, repeatCustomers: 4, newCustomersInPeriod: 2 }, topCustomers: [], byPeriod: [],
});
const PERIOD = contract(PeriodKpisSchema, {
  period: 'today', dateFrom: '2026-11-12', dateTo: '2026-11-12', netSales: 575, grossProfit: 300, grossMarginPct: 52.2, netProfit: 283,
  previous: { dateFrom: '2026-11-11', dateTo: '2026-11-11', netSales: 0, grossProfit: 0, grossMarginPct: 0, netProfit: 0 },
  netSalesChangePct: null, grossProfitChangePct: null, netProfitChangePct: null, cashIn: 575, cashOut: 20, cashCollected: 555, previousCashCollected: 0,
});

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/reports/kpis/period')) return Promise.resolve(PERIOD);
    if (path.startsWith('/reports/sales')) return Promise.resolve(SALES);
    if (path.startsWith('/reports/payments')) return Promise.resolve(PAYMENTS);
    if (path.startsWith('/reports/exchanges')) return Promise.resolve(EXCHANGES);
    if (path.startsWith('/reports/inventory')) return Promise.resolve(INVENTORY);
    if (path.startsWith('/reports/customers')) return Promise.resolve(CUSTOMERS);
    if (path.startsWith('/config/currency')) return Promise.resolve({ currency: 'ETB' });
    return Promise.resolve({ items: [] });
  });
});

function renderSections() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const params = { dateFrom: '2026-11-12', dateTo: '2026-11-12', groupBy: 'day' as const };
  render(
    <QueryClientProvider client={qc}>
      <SalesTrend params={params} />
      <DiscountSummary params={params} />
      <PaymentMethods params={params} period="today" />
      <ExchangeActivity params={params} />
      <InventoryInsights params={params} />
      <CustomerInsights params={params} />
    </QueryClientProvider>,
  );
}

describe('The dashboard\'s figures (#268)', () => {
  it.each(Object.entries(GLOSSARY) as Array<[FigureLabel, string]>)('"%s" says under it what it counts', async (label, meaning) => {
    renderSections();
    const figure = await screen.findByRole('group', { name: label });
    expect(figure).toHaveAccessibleDescription(meaning);
    expect(figure).toHaveTextContent(meaning);
  });

  it('shows no figure without its line: every figure shown is in the glossary', async () => {
    renderSections();
    await screen.findByRole('group', { name: 'Net Profit' });
    await screen.findByRole('group', { name: 'New (period)' });
    for (const figure of screen.getAllByRole('group')) {
      expect(Object.keys(GLOSSARY), figure.textContent ?? '').toContain(figure.getAttribute('data-figure'));
    }
  });
});
