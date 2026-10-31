// #169 PR 2 (owner decisions 1a, 2a, 3a, 4a, 5a, 6a): binding on a sale. At
// the counter and on a new order, a book line takes a binding for some or all
// of its copies, as its own line under the book, at the branch's fee; a
// discount only where the service allows it. A binding needs a named
// customer. A sale's and an order's job is shown with its number, status and
// ready date, and whoever sells moves it on; an order's ready job goes with
// the order at delivery. Before, a sale carried books only. Every mocked
// answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CurrencyResponseSchema, CustomerListResponseSchema, CustomerSchema, EffectiveConfigResponseSchema,
  LocationListResponseSchema, OrderListResponseSchema, OrderSchema, PosTransactionListResponseSchema, PosTransactionSchema, ProfileResponseSchema,
  ReturnListResponseSchema, ServiceJobSchema, ServiceListResponseSchema, ServiceSchema,
  type Book, type Order, type PosTransaction, type ProfileResponse, type SaleServiceLine, type Service,
} from '@bms/shared';
import PosPage from '../features/pos/pages/PosPage.js';
import OrdersPage from '../features/orders/pages/OrdersPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-25T07:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const book = (id: number, title: string): Book => contract(BookSchema, {
  id, isbn: `97803064061${String(id).padStart(2, '0')}`, sku: null, title, authors: [], authorIds: [], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice: 100,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
});

const service = (over: Partial<Service>): Service => contract(ServiceSchema, {
  id: 1, code: 'BIND-LEATHER', name: 'Leather binding', kind: 'binding', formatId: 3, formatLabel: 'Leather Bound', fee: 250,
  branchFee: 280, effectiveFee: 280, standardCost: 120, discountable: false, turnaroundDays: 5, status: 'ACTIVE',
  createdAt: CREATED, updatedAt: CREATED, ...over,
});
const SERVICES = [service({}), service({ id: 2, code: 'BIND-CLOTH', name: 'Cloth binding', fee: 100, branchFee: null, effectiveFee: 100, discountable: true })];

const job = (status: 'REQUESTED' | 'AT_BINDER' | 'READY' | 'COLLECTED') => contract(ServiceJobSchema, {
  id: 31, jobNumber: 'SVC-20261025-0001', status, readyDate: '2026-10-30', customerId: 1, branchId: 1, updatedAt: CREATED,
});
const bound = (status: 'REQUESTED' | 'AT_BINDER' | 'READY' | 'COLLECTED'): SaleServiceLine => ({
  id: 4, serviceId: 1, serviceCode: 'BIND-LEATHER', serviceName: 'Leather binding', quantity: 2, unitFee: 280, discountAmount: 0,
  lineTotal: 560, standardCost: 120, job: job(status),
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let saleAnswer: PosTransaction;
let theOrder: Order;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: 'ETB' }));
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, {
        items: [{ id: 7, branchId: 1, name: 'Main Floor', isDefaultFulfillment: true, createdAt: CREATED }], total: 1, accessMode: 'full',
      }));
    }
    if (u.pathname === '/config/effective') {
      const values: Record<string, unknown> = { allow_negative_stock: false, max_line_discount_pct: { Sales: 10, Manager: 25 } };
      const keys = (u.searchParams.get('keys') ?? '').split(',').filter((k) => k in values);
      return json(contract(EffectiveConfigResponseSchema, { items: keys.map((key) => ({ key, value: values[key], source: 'system' as const })) }));
    }
    if (u.pathname === '/books/with-availability') {
      return json(contract(BookAvailabilityListResponseSchema, {
        items: [{ ...book(2, 'Oromay'), availability: { locationId: 7, locationName: 'Main Floor', onHand: 5, reserved: 0, available: 5 } }],
        total: 1, page: 1, pageSize: 10, totalPages: 1,
      }));
    }
    if (u.pathname === '/services') {
      return json(contract(ServiceListResponseSchema, { items: SERVICES, total: 2, page: 1, pageSize: 100, totalPages: 1 }));
    }
    if (u.pathname === '/customers') {
      return json(contract(CustomerListResponseSchema, {
        items: [contract(CustomerSchema, {
          id: 1, branchId: 1, customerCode: 'CUS-0001', fullName: 'Abebe Kebede', phone: '0911000000', email: null, gender: null,
          dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
          loyaltyBalance: 0, lifetimePoints: 0, storeCreditBalance: 0, outstandingReceivables: 0, groups: [],
        })],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (method === 'POST' && u.pathname === '/pos/transactions') return json(contract(PosTransactionSchema, saleAnswer));
    if (u.pathname === '/pos/transactions') {
      return json(contract(PosTransactionListResponseSchema, { items: [{ ...saleAnswer, lineItems: undefined, payments: undefined }], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === `/pos/transactions/${saleAnswer.id}`) return json(contract(PosTransactionSchema, saleAnswer));
    const step = u.pathname.match(/^\/service-jobs\/(\d+)\/(send|ready|collect)$/);
    if (method === 'POST' && step) return json(job(step[2] === 'send' ? 'AT_BINDER' : step[2] === 'ready' ? 'READY' : 'COLLECTED'));
    if (method === 'POST' && (u.pathname === '/orders' || u.pathname === `/orders/${theOrder.id}/confirm`)) return json(contract(OrderSchema, theOrder));
    if (u.pathname === '/orders' && method === 'GET') {
      return json(contract(OrderListResponseSchema, { items: [{ ...theOrder, lineItems: undefined }], total: 1, page: 1, pageSize: 10, totalPages: 1 }));
    }
    if (u.pathname === `/orders/${theOrder.id}`) return json(contract(OrderSchema, theOrder));
    if (u.pathname === '/returns') return json(contract(ReturnListResponseSchema, { items: [], total: 0, page: 1, totalPages: 0 }));
    if (u.pathname.includes('/bank-accounts')) return new Response('{}', { status: 404 });
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body as Record<string, unknown>);

function sale(over: Partial<PosTransaction> = {}): PosTransaction {
  return contract(PosTransactionSchema, {
    id: '77', branchId: 1, locationId: 7, customerId: 1, staffId: 9, transactionNumber: 'POS-20261025-0001',
    subtotal: 860, discountTotal: 0, taxTotal: 0, grandTotal: 860, amountPaid: 860, amountDue: 0, paymentStatus: 'paid',
    currency: 'ETB', status: 'completed', createdAt: CREATED, dueDate: null, voidable: true,
    lineItems: [{
      id: '5', transactionId: '77', bookId: 2, bookTitle: 'Oromay', bookIsbn: '1', quantity: 3, unitPrice: 100, discountPct: 0,
      discountAmount: 0, lineTotal: 300, unitCost: 40, service: bound('REQUESTED'),
    }],
    payments: [{ id: '1', transactionId: '77', method: 'cash', amount: 860, reference: null, payerBank: null, bankAccountId: null, createdAt: CREATED }],
    ...over,
  });
}

function order(status: 'REQUESTED' | 'AT_BINDER' | 'READY', allowedActions: string[]): Order {
  return contract(OrderSchema, {
    id: '10', orderNumber: 'ORD-20261025-0001', customerId: 1, branchId: 1, locationId: 7, channel: 'in_store',
    status: 'CONFIRMED', paymentStatus: 'paid', amountPaid: 760, saleType: 'cash_sale', currency: 'ETB', subtotal: 760, discountAmount: 0,
    discountTotal: 0, taxRate: 0, taxAmount: 0, total: 760, cancelReason: null, notes: null, createdBy: 9,
    createdAt: CREATED, updatedAt: CREATED, allowedActions, paymentMethod: 'cash', dueDate: null, fulfilledAt: null,
    lineItems: [{
      id: '8', orderId: '10', bookId: 2, bookTitle: 'Oromay', bookIsbn: '1', quantity: 2, unitPrice: 100, discountAmount: 0,
      totalPrice: 200, discountType: 'Normal', discountMode: 'Amount', discountPct: 0, qtyReserved: 2, qtyFulfilled: 0, isBackordered: false, unitCost: 40, qtyReturned: 0, qtyCancelled: 0, service: bound(status),
    }],
  });
}

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  saleAnswer = sale();
  theOrder = order('REQUESTED', ['cancel']);
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('binding at the counter (1a, 2a, 3a)', () => {
  async function cartWithOromay() {
    const user = renderWith(<PosPage userRole="Sales" userPermissions={['CREATE_SALE']} />);
    await screen.findByDisplayValue(/Main Floor/);
    await settle();
    await user.type(screen.getByPlaceholderText('Title, ISBN, Author…'), 'Orom');
    await user.click(await screen.findByText('Oromay'));
    await user.click(screen.getByRole('button', { name: '＋' }));
    await user.click(screen.getByRole('button', { name: '＋' }));
    return user;
  }

  it('adds a binding for some of the line\'s copies at the branch\'s fee, as its own line in the total (was: books only)', async () => {
    const user = await cartWithOromay();
    await user.click(screen.getByRole('button', { name: '+ Binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Binding: Oromay' });
    await user.selectOptions(within(dialog).getByLabelText('Binding'), 'Leather binding — ETB 280.00, ready in 5 days');
    expect(within(dialog).queryByLabelText('Discount (%)')).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Copies (of 3)'));
    await user.type(within(dialog).getByLabelText('Copies (of 3)'), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Copies to bind: 1 to 3');
    await user.clear(within(dialog).getByLabelText('Copies (of 3)'));
    await user.type(within(dialog).getByLabelText('Copies (of 3)'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Leather binding × 2/)).toBeInTheDocument();
    expect(screen.getByText('560.00')).toBeInTheDocument();
    expect(screen.getAllByText(/860\.00/).length).toBeGreaterThan(0);
  });

  it('needs a customer for a binding, then sends the binding with its line', async () => {
    const user = await cartWithOromay();
    await user.click(screen.getByRole('button', { name: '+ Binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Binding: Oromay' });
    await user.selectOptions(within(dialog).getByLabelText('Binding'), 'Leather binding — ETB 280.00, ready in 5 days');
    await user.clear(within(dialog).getByLabelText('Copies (of 3)'));
    await user.type(within(dialog).getByLabelText('Copies (of 3)'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('⚠ A binding needs a customer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Complete Sale/ })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Search customer… (F9)'), 'Abe');
    await user.click(await screen.findByText('Abebe Kebede'));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));
    await waitFor(() => expect(posted('/pos/transactions')).toHaveLength(1));
    expect(posted('/pos/transactions')[0]).toMatchObject({
      customerId: 1,
      items: [{ bookId: 2, quantity: 3, service: { serviceId: 1, quantity: 2 } }],
      payments: [{ method: 'cash', amount: 860 }],
    });
    // The receipt lists the binding under its book, with its job.
    expect(await screen.findByText(/SVC-20261025-0001 · ready 2026-10-30/)).toBeInTheDocument();
  });

  it('discounts a discountable fee only, within the cashier\'s limit', async () => {
    const user = await cartWithOromay();
    await user.click(screen.getByRole('button', { name: '+ Binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Binding: Oromay' });
    await user.selectOptions(within(dialog).getByLabelText('Binding'), 'Cloth binding — ETB 100.00, ready in 5 days');
    await user.type(within(dialog).getByLabelText('Discount (%)'), '20');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('The discount is more than your limit of 10%');
    await user.clear(within(dialog).getByLabelText('Discount (%)'));
    await user.type(within(dialog).getByLabelText('Discount (%)'), '10');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    // 3 copies × 100, less 10%.
    expect(screen.getByText('270.00')).toBeInTheDocument();
  });
});

describe('binding on a new order (1a, 2a, 5a)', () => {
  it('adds a binding to a line, counts its fee, needs a customer, and sends it with the line', async () => {
    const user = renderWith(<OrdersPage initialContext={{}} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /New Order/i }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Orom');
    await user.click(await screen.findByText('Oromay'));
    await user.click(screen.getByRole('button', { name: '+ Binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Binding: Oromay' });
    await user.selectOptions(within(dialog).getByLabelText('Binding'), 'Cloth binding — ETB 100.00, ready in 5 days');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Cloth binding × 1/)).toBeInTheDocument();
    // The book's 100 and the binding's 100.
    expect(screen.getByText('Subtotal').parentElement?.textContent).toMatch(/ETB 200(\.00)?$/);

    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(await screen.findByText('A binding needs a customer, who is called when it is ready')).toBeInTheDocument();
    expect(posted('/orders')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('Search customer...'), 'Abe');
    await user.click(await screen.findByText('Abebe Kebede'));
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    await waitFor(() => expect(posted('/orders')).toHaveLength(1));
    expect(posted('/orders')[0]).toMatchObject({ customerId: 1, items: [{ bookId: 2, quantity: 1, service: { serviceId: 2, quantity: 1 } }] });
  });
});

describe('a binding job (4a)', () => {
  it('shows a sale\'s job in Sales History and moves it on by whoever sells', async () => {
    const user = renderWith(<PosPage userRole="Sales" userPermissions={['CREATE_SALE']} />);
    await user.click(await screen.findByRole('button', { name: /Sales History/ }));
    await user.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText('SVC-20261025-0001')).toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('ready 2026-10-30')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sent to binder' }));
    await waitFor(() => expect(posted('/service-jobs/31/send')).toHaveLength(1));
  });

  it('shows an order\'s job; the order is delivered only once it is ready, and its ready job goes with the order', async () => {
    const user = renderWith(<OrdersPage initialContext={{}} onNavigate={vi.fn()} />);
    const row = (await screen.findByText('ORD-20261025-0001')).closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /Fulfill/i })).not.toBeInTheDocument();
    await user.click(row);
    expect(await screen.findByText('SVC-20261025-0001')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sent to binder' }));
    await waitFor(() => expect(posted('/service-jobs/31/send')).toHaveLength(1));
  });

  it('offers no Collected step on an order: the ready job goes with the delivery', async () => {
    theOrder = order('READY', ['cancel', 'fulfill']);
    const user = renderWith(<OrdersPage initialContext={{}} onNavigate={vi.fn()} />);
    const row = (await screen.findByText('ORD-20261025-0001')).closest('tr') as HTMLElement;
    await user.click(row);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collected' })).not.toBeInTheDocument();
  });

  it('offers no job step to a role that does not sell', async () => {
    me = profile(['Stock_Clerk']);
    const user = renderWith(<OrdersPage initialContext={{}} onNavigate={vi.fn()} />);
    await user.click((await screen.findByText('ORD-20261025-0001')).closest('tr') as HTMLElement);
    expect(await screen.findByText('SVC-20261025-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sent to binder' })).not.toBeInTheDocument();
  });
});
