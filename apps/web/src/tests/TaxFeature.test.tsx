// #247 part 2 (owner decisions 1a–4a, 2026-11-11; ADR-0010): the tax on the
// screens. Settings has a Tax tab that Super_Admin and Admin change (every
// other shop-wide setting stays Super_Admin's), and turning tax on is
// confirmed first. A receipt or slip whose document carries a rate shows,
// under its total, the tax the total includes, named as the shop names it,
// and the net before tax; one with no rate shows neither. The day report
// and the sales report show the tax included once there is any. Before, none
// of this was on any screen. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import {
  ConfigEntrySchema, ExchangeSchema, OrderSchema, ProfileResponseSchema, ReturnSchema, SalesReportSchema, ShopIdentitySchema,
  SystemConfigListResponseSchema, BranchListResponseSchema,
  type DayReport, type Exchange, type Order, type ProfileResponse, type Return, type SalesReport,
} from '@bms/shared';
import SettingsPage from '../features/settings/pages/SettingsPage.js';
import { OrderSlip } from '../features/orders/components/OrderSlip.js';
import { ReturnSlip } from '../features/returns/components/ReturnSlip.js';
import { ExchangeSlip } from '../features/exchanges/components/ExchangeSlip.js';
import { DayReportView } from '../features/businessDays/components/DayReport.js';
import { SalesTrend } from '../features/dashboard/components/SalesSections.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';
import { EMPTY_REPORTS } from './reportFixtures.js';
import { SHOP_IDENTITY } from './shop.js';

const CREATED = '2026-11-11T08:00:00.000Z';

// The sales report draws its trend; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const entry = (key: string, value: unknown) => ({ key, value, updatedBy: 1, updatedAt: CREATED });
const SYSTEM = [
  entry('shop_name', 'Kuraz Books'), entry('return_window_days', 7),
  entry('tax_enabled', false), entry('tax_rate_pct', 15), entry('tax_name', 'VAT'),
];

const order = (over: Partial<Order> = {}): Order => contract(OrderSchema, {
  id: '10', orderNumber: 'ORD-20261111-0001', customerId: null, customerName: null, branchId: 1, locationId: 7, channel: 'in_store',
  status: 'CONFIRMED', paymentStatus: 'paid', amountPaid: 230, saleType: 'cash_sale', currency: 'ETB', subtotal: 230, discountAmount: 0,
  discountTotal: 0, taxRate: 0.15, taxAmount: 30, total: 230, cancelReason: null, notes: null, createdBy: 9,
  createdAt: CREATED, updatedAt: CREATED, allowedActions: ['print'], paymentMethod: 'cash', dueDate: null, fulfilledAt: null,
  lineItems: [{
    id: '8', orderId: '10', bookId: 1, bookTitle: 'Oromay', bookIsbn: '2', quantity: 2, unitPrice: 115, discountAmount: 0,
    totalPrice: 230, discountType: 'Normal', discountMode: 'Amount', discountPct: 0, qtyReserved: 2, qtyFulfilled: 0, isBackordered: false,
    unitCost: 50, qtyReturned: 0, qtyCancelled: 0, specialOrder: false, qtyOnOrder: 0, qtyToOrder: 0, purchaseOrders: [], service: null,
  }],
  ...over,
});

const ret = (over: Partial<Return> = {}): Return => contract(ReturnSchema, {
  id: '5', returnNumber: 'RET-20261111-0001', transactionId: '41', transactionNumber: 'POS-20261111-0001', branchId: 1,
  customerId: null, totalRefundAmount: 115, taxRate: 0.15, taxAmount: 15, refundMethod: 'cash', status: 'completed', reason: 'Bought twice',
  processedBy: 9, approvedBy: null, undelivered: false, createdAt: CREATED, orderId: null, orderNumber: null, exchangeId: null, exchangeReference: null,
  lineItems: [{ id: '1', returnId: '5', transactionLineItemId: '7', orderLineItemId: null, exchangeLineItemId: null, bookId: 1, bookTitle: 'Oromay', quantity: 1, unitPrice: 115, lineRefundAmount: 115 }],
  refunds: [{ id: '1', returnId: '5', method: 'cash', amount: 115, createdAt: CREATED }],
  ...over,
});

const exchange = (over: Partial<Exchange> = {}): Exchange => {
  const item = (id: string, bookId: number, bookTitle: string, unitPrice: number) => ({ id, exchangeId: '7', bookId, bookTitle, quantity: 1, unitPrice, totalPrice: unitPrice });
  return contract(ExchangeSchema, {
    id: '7', exchangeReference: 'EXC-20261111-0001', branchId: 1, locationId: 9, customerId: null, status: 'Completed',
    lifecycleStatus: null, totalIncomingValue: 100, totalOutgoingValue: 115, netBalance: 15, taxRate: 0.15, taxAmount: 1.96, settlementType: 'Customer_Pays',
    refundMethod: null, currency: 'ETB', notes: null, createdBy: 9, createdAt: CREATED, updatedAt: CREATED, outstandingAmount: 0,
    dueDate: null, settlementStatus: 'Settled', voidable: true, voidedAt: null, voidedBy: null, voidReason: null,
    incomingItems: [{ ...item('1', 1, 'Fikir Eske Mekabir', 100), condition: 'resellable' }],
    outgoingItems: [item('2', 2, 'Oromay', 115)],
    settlementEntries: [{ id: '1', entryType: 'cash_payment', amount: 15, method: 'cash', reference: null, payerBank: null, createdAt: CREATED }],
    ...over,
  });
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let answers: Record<string, unknown>;

beforeEach(() => {
  setAccessToken('x');
  calls = [];
  me = profile(['Admin']);
  answers = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/shop') return json(contract(ShopIdentitySchema, SHOP_IDENTITY));
    if (u.pathname === '/config/currency') return json({ currency: 'ETB' });
    if (u.pathname === '/config/system' && method === 'GET') return json(contract(SystemConfigListResponseSchema, { items: SYSTEM, total: SYSTEM.length }));
    if (u.pathname === '/branches') return json(contract(BranchListResponseSchema, { items: [], total: 0, page: 1, pageSize: 100, totalPages: 0 }));
    if (method === 'PUT') return json(contract(ConfigEntrySchema, entry(u.pathname.split('/').pop()!, body.value)));
    if (u.pathname in answers) return json(answers[u.pathname]);
    return json({});
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

/** Lets every answer arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const settingRow = async (label: string) => (await screen.findByText(label)).closest('div.flex.items-start')! as HTMLElement;
const slipRow = (slip: HTMLElement, label: string) => within(slip).getByText(label).closest('div')!;

describe('Settings: the Tax tab (1a)', () => {
  it('lists the switch, the rate and the name, changed by Admin, and no other shop-wide setting', async () => {
    const user = userEvent.setup();
    renderWith(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Tax' }));
    for (const label of ['Charge Tax', 'Tax Rate %', 'Tax Name']) expect(within(await settingRow(label)).getByTitle('Edit')).toBeInTheDocument();
    expect(screen.getByText('Tax: editable by Super_Admin and Admin')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Shop' }));
    await settle();
    expect(within(await settingRow('Shop Name')).queryByTitle('Edit')).not.toBeInTheDocument();
  });

  it('is read-only for a Manager', async () => {
    me = profile(['Manager']);
    const user = userEvent.setup();
    renderWith(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Tax' }));
    await settle();
    expect(within(await settingRow('Charge Tax')).queryByTitle('Edit')).not.toBeInTheDocument();
    expect(within(await settingRow('Tax Rate %')).queryByTitle('Edit')).not.toBeInTheDocument();
  });

  it('asks before turning tax on, saying prices stay and it holds from the next document; Back sends nothing', async () => {
    const user = userEvent.setup();
    renderWith(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Tax' }));
    const row = await settingRow('Charge Tax');
    await user.click(within(row).getByTitle('Edit'));
    await user.selectOptions(within(row).getByRole('combobox'), 'true');
    await user.click(within(row).getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Turn tax on?' });
    expect(dialog).toHaveTextContent('Prices stay as they are: they include VAT at 15%');
    expect(dialog).toHaveTextContent('from the next sale, order, return or exchange');
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await user.click(within(row).getByTitle('Edit'));
    await user.selectOptions(within(row).getByRole('combobox'), 'true');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Turn tax on?' })).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/config/system/tax_enabled', body: { value: true } }));
  });

  it('checks the rate with the API\'s rules before sending it', async () => {
    const user = userEvent.setup();
    renderWith(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Tax' }));
    const row = await settingRow('Tax Rate %');
    await user.click(within(row).getByTitle('Edit'));
    const input = within(row).getByRole('spinbutton');
    await user.clear(input);
    await user.type(input, '0');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByRole('alert')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('Receipts and slips (2a)', () => {
  it('an order slip shows the VAT its total includes and the net before tax (was: "Tax" alone)', async () => {
    answers['/orders/10'] = order();
    renderWith(<OrderSlip orderId="10" onClose={() => {}} />);
    const slip = await screen.findByRole('dialog', { name: 'Order ORD-20261111-0001' });
    await within(slip).findByText('Includes VAT 15%');
    expect(slipRow(slip, 'Includes VAT 15%')).toHaveTextContent('ETB 30.00');
    expect(slipRow(slip, 'Net before tax')).toHaveTextContent('ETB 200.00');
    expect(within(slip).queryByText('Tax')).not.toBeInTheDocument();
  });

  it('a slip of a document made with tax off shows neither', async () => {
    answers['/orders/10'] = order({ taxRate: 0, taxAmount: 0 });
    renderWith(<OrderSlip orderId="10" onClose={() => {}} />);
    const slip = await screen.findByRole('dialog', { name: 'Order ORD-20261111-0001' });
    await within(slip).findByText('Oromay');
    expect(slip).not.toHaveTextContent('Includes');
    expect(slip).not.toHaveTextContent('Net before tax');
  });

  it('a return slip shows the tax given back, at the sale\'s rate', async () => {
    answers['/returns/5'] = ret();
    renderWith(<ReturnSlip returnId="5" onClose={() => {}} />);
    const slip = await screen.findByRole('dialog', { name: 'Return RET-20261111-0001' });
    await within(slip).findByText('Includes VAT 15%');
    expect(slipRow(slip, 'Includes VAT 15%')).toHaveTextContent('ETB 15.00');
    expect(slipRow(slip, 'Net before tax')).toHaveTextContent('ETB 100.00');
  });

  it('an exchange slip shows the tax inside the difference, and a rate such as 7.5%', async () => {
    answers['/exchanges/7'] = exchange({ taxRate: 0.075, taxAmount: 1.05 });
    renderWith(<ExchangeSlip exchangeId="7" onClose={() => {}} />);
    const slip = await screen.findByRole('dialog', { name: 'Exchange EXC-20261111-0001' });
    await within(slip).findByText('Includes VAT 7.5%');
    expect(slipRow(slip, 'Includes VAT 7.5%')).toHaveTextContent('ETB 1.05');
    expect(slipRow(slip, 'Net before tax')).toHaveTextContent('ETB 13.95');
  });
});

describe('Reports (3a)', () => {
  const day = (tax: number): DayReport => ({
    sales: { orders: { count: 1, total: 230 }, pos: { count: 2, total: 230 }, exchanges: { count: 1 }, tax },
    money: { byMethod: [], totalIn: 0, totalOut: 0 },
    returns: { count: 0, refunded: 0 },
    stock: [],
    cash: { sessions: [], totalVariance: 0 },
  });

  it("the day report shows the tax inside the day's sales", () => {
    renderWith(<DayReportView report={day(42.41)} />);
    expect(screen.getByText('Tax included').closest('div')!).toHaveTextContent(/42\.41/);
  });

  it('the day report shows no tax figure when there is none', () => {
    renderWith(<DayReportView report={day(0)} />);
    expect(screen.queryByText('Tax included')).not.toBeInTheDocument();
  });

  const sales = (taxIncluded: number): SalesReport => contract(SalesReportSchema, {
    ...EMPTY_REPORTS.sales,
    summary: { ...EMPTY_REPORTS.sales.summary, netSales: 460, taxIncluded, netSalesBeforeTax: 460 - taxIncluded },
    byPeriod: [{ period: '2026-11-11', totalSales: 230, totalOrders: 1, averageOrderValue: 230 }],
  });

  it('the sales report shows the tax included and net sales before tax', async () => {
    answers['/reports/sales'] = sales(60);
    renderWith(<SalesTrend params={{ dateFrom: '2026-11-11', dateTo: '2026-11-11', groupBy: 'day' }} />);
    expect((await screen.findByText('Tax included')).closest('div')!).toHaveTextContent('60');
    expect(screen.getByText('Net sales before tax').closest('div')!).toHaveTextContent('400');
  });

  it('the sales report shows neither when no sale carried tax', async () => {
    answers['/reports/sales'] = sales(0);
    renderWith(<SalesTrend params={{ dateFrom: '2026-11-11', dateTo: '2026-11-11', groupBy: 'day' }} />);
    await screen.findByText('Order Sales');
    expect(screen.queryByText('Tax included')).not.toBeInTheDocument();
  });
});
