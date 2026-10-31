// #174 (owner decisions 1a–6a for the special-order screens, 2026-10-31): a
// book not in stock is ordered for a customer. The order form adds it as a
// special order, which makes the order a credit sale, and takes a deposit
// when it is confirmed. The order shows the line as a special order with its
// copies on order, and reserves from stock what was brought over. In
// Procurement, purchasers add the copies still to buy to a draft purchase
// order or start one, and the purchase order shows which copies are for
// which customer's order. A notification about an order opens it. Before,
// a book out of stock could not be ordered at all. Every mocked answer is
// checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CustomerListResponseSchema, CustomerSchema, EffectiveConfigResponseSchema,
  LocationListResponseSchema, OrderListResponseSchema, OrderSchema, ProfileResponseSchema, PurchaseOrderListResponseSchema,
  PurchaseOrderSchema, SpecialOrderListResponseSchema,
  type Book, type Customer, type Order, type OrderLineItem, type ProfileResponse, type PurchaseOrder,
} from '@bms/shared';
import OrdersPage from '../features/orders/pages/OrdersPage.js';
import ProcurementPage from '../features/procurement/pages/ProcurementPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-31T07:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const book = (id: number, title: string, defaultPrice: number): Book => contract(BookSchema, {
  id, isbn: `97803064061${String(id).padStart(2, '0')}`, sku: null, title, authors: [], authorIds: [], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
});

const customer: Customer = contract(CustomerSchema, {
  id: 5, branchId: 1, customerCode: 'CUS-0005', fullName: 'Abebe Kebede', phone: null, email: null, gender: null,
  dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
  loyaltyBalance: 0, lifetimePoints: 0, storeCreditBalance: 0, outstandingReceivables: 0, groups: [],
});

const line = (over: Partial<OrderLineItem> = {}): OrderLineItem => ({
  id: '51', orderId: '30', bookId: 9, bookTitle: 'Yegna Tarik', bookIsbn: '9780306406109', quantity: 2, unitPrice: 40, discountAmount: 0,
  totalPrice: 80, discountType: 'Normal', discountMode: 'Amount', discountPct: 0, qtyReserved: 0, qtyFulfilled: 0, isBackordered: false,
  unitCost: null, qtyReturned: 0, qtyCancelled: 0, specialOrder: true, qtyOnOrder: 2, service: null, ...over,
});

function order(over: Partial<Order> = {}): Order {
  return contract(OrderSchema, {
    id: '30', orderNumber: 'ORD-20261031-0030', customerId: 5, branchId: 1, locationId: 7, channel: 'in_store',
    status: 'CONFIRMED', paymentStatus: 'partial', amountPaid: 20, saleType: 'credit_sale', currency: 'ETB', subtotal: 80, discountAmount: 0,
    discountTotal: 0, taxRate: 0, taxAmount: 0, total: 80, cancelReason: null, notes: null, createdBy: 9,
    createdAt: CREATED, updatedAt: CREATED, allowedActions: ['cancel'], paymentMethod: 'cash', dueDate: '2099-12-31', fulfilledAt: null,
    deliveries: [], lineItems: [line()], ...over,
  });
}

function po(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return contract(PurchaseOrderSchema, {
    id: '7', poNumber: 'PO-000007', branchId: 1, supplierId: 3, supplierName: 'Acme Distributors', status: 'draft',
    totalAmount: 60, currency: 'ETB', expectedDeliveryDate: null, notes: null, receivingBranchId: 1, receivingLocationId: 7,
    receivingLocationName: 'Main Store', financialStatus: 'unpaid', paymentTerms: 'credit', createdBy: 9, approvedBy: null,
    approvedAt: null, approvalKind: null, approvalReason: null, approvalThreshold: 1000,
    closedReason: null, closedBy: null, closedAt: null, createdAt: CREATED, updatedAt: CREATED,
    receivedValue: 0, amountPaid: 0, creditNotesTotal: 0, refundsTotal: 0, outstandingAmount: 0, refundDue: 0,
    orderedQuantityTotal: 2, receivedQuantityTotal: 0,
    lineItems: [{
      id: '701', poId: '7', bookId: 9, bookTitle: 'Yegna Tarik', bookIsbn: '9780306406109', formatId: null, editionId: null,
      quantity: 2, unitCost: 30, receivedQuantity: 0, returnedQuantity: 0, remaining: 2,
      specialOrders: [{ orderLineId: '51', orderId: '30', orderNumber: 'ORD-20261031-0030', quantity: 2, reserved: 0 }],
    }],
    receipts: [], payments: [], creditNotes: [], supplierRefunds: [],
    ...over,
  });
}

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let current: Order;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 25, totalPages: 1 });
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, {
        items: [{ id: 7, branchId: 1, name: 'Main Store', isDefaultFulfillment: true, createdAt: CREATED }], total: 1, accessMode: 'full',
      }));
    }
    if (u.pathname === '/config/effective') return json(contract(EffectiveConfigResponseSchema, { items: [] }));
    if (u.pathname === '/books/with-availability') {
      return json(contract(BookAvailabilityListResponseSchema, {
        items: [{ ...book(9, 'Yegna Tarik', 40), availability: { locationId: 7, locationName: 'Main Store', onHand: 0, reserved: 0, available: 0 } }],
        total: 1, page: 1, pageSize: 8, totalPages: 1,
      }));
    }
    if (u.pathname === '/customers') return json(contract(CustomerListResponseSchema, { items: [customer], total: 1, page: 1, totalPages: 1 }));
    if (u.pathname === '/customers/5') return json(contract(CustomerSchema, customer));
    if (method === 'POST' && u.pathname === '/orders') return json(contract(OrderSchema, order({ status: 'DRAFT', allowedActions: [] })), 201);
    if (method === 'POST' && u.pathname === '/orders/30/confirm') return json(contract(OrderSchema, current));
    if (method === 'POST' && u.pathname === '/orders/30/lines/51/reserve') {
      current = order({ lineItems: [line({ qtyReserved: 2, qtyOnOrder: 0 })], allowedActions: ['cancel', 'deliver', 'fulfill'] });
      return json(contract(OrderSchema, current));
    }
    if (u.pathname === '/orders/30') return json(contract(OrderSchema, current));
    if (u.pathname === '/orders') {
      return json(contract(OrderListResponseSchema, { ...page([{ ...current, lineItems: undefined, deliveries: undefined }]), pageSize: 10 }));
    }
    if (u.pathname === '/special-orders') {
      return json(contract(SpecialOrderListResponseSchema, page([{
        orderLineId: '51', orderId: '30', orderNumber: 'ORD-20261031-0030', orderedAt: CREATED, customerId: 5, customerName: 'Abebe Kebede',
        bookId: 9, bookTitle: 'Yegna Tarik', isbn: '9780306406109', quantity: 2, onOrder: 2, linked: 0, toOrder: 2, purchaseOrders: [],
      }])));
    }
    if (u.pathname === '/purchase-orders' && method === 'GET') {
      return json(contract(PurchaseOrderListResponseSchema, page([{ ...po(), lineItems: undefined, receipts: undefined, payments: undefined, creditNotes: undefined, supplierRefunds: undefined }])));
    }
    if (method === 'POST' && (u.pathname === '/purchase-orders' || u.pathname === '/purchase-orders/7/special-orders')) {
      return json(contract(PurchaseOrderSchema, po()), u.pathname === '/purchase-orders' ? 201 : 200);
    }
    if (u.pathname === '/purchase-orders/7') return json(contract(PurchaseOrderSchema, po()));
    if (u.pathname === '/suppliers') return json({ ...page([{ id: 3, name: 'Acme Distributors' }]), pageSize: 10 });
    return json({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 60)));
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body as Record<string, unknown>);

function renderPage(page: 'orders' | 'procurement', initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Page = page === 'orders' ? OrdersPage : ProcurementPage;
  render(<QueryClientProvider client={qc}><ToastProvider><Page initialContext={initialContext} /></ToastProvider></QueryClientProvider>);
}

describe('Special orders on screen (#174)', () => {
  beforeEach(() => {
    setAccessToken('t'); setCurrentBranchId(1);
    me = profile(['Manager']);
    current = order();
    stubApi();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('orders a book not in stock for a customer, as a credit sale with a deposit (was: refused as out of stock)', async () => {
    renderPage('orders');
    await settle();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '+ New Order' }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Yeg');
    await user.click(await screen.findByRole('button', { name: /Yegna Tarik.*special order/i }));
    expect((screen.getByLabelText('Special order: Yegna Tarik') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('button', { name: '+ Binding' })).toBeNull();
    expect(screen.getByRole('button', { name: /Credit Sale/ }).className).toMatch(/bg-amber-600/);
    // Copies on order are not limited by the stock.
    await user.click(screen.getByRole('button', { name: 'One more Yegna Tarik' }));
    expect(screen.getByLabelText('Quantity of Yegna Tarik').textContent).toBe('2');

    await user.type(screen.getByPlaceholderText('Search customer...'), 'Abe');
    await user.click(await screen.findByRole('button', { name: /Abebe Kebede/ }));
    await user.type(screen.getByLabelText('Due date'), '2099-12-31');
    await user.type(screen.getByLabelText('Deposit (optional)'), '20');
    await user.click(screen.getByRole('button', { name: 'Create Order' }));
    await settle();
    expect(sent('POST', '/orders')[0]).toMatchObject({ saleType: 'credit_sale', customerId: 5, items: [{ bookId: 9, quantity: 2, specialOrder: true }] });
    expect(sent('POST', '/orders/30/confirm')).toEqual([{ dueDate: '2099-12-31', deposit: 20, paymentMethod: 'cash' }]);
  });

  it('shows a special-order line with its copies on order, and reserves what was brought over', async () => {
    renderPage('orders', { orderId: '30' });
    await settle();
    // Opened from a notification, the order is shown expanded.
    expect(await screen.findByText('Special order')).toBeTruthy();
    expect(screen.getByRole('row', { name: /^Yegna Tarik/ }).textContent).toMatch(/On order 2/);
    expect(screen.queryByRole('button', { name: 'Fulfill' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reserve Yegna Tarik from stock' }));
    await settle();
    expect(sent('POST', '/orders/30/lines/51/reserve')).toEqual([undefined]);
  });

  it('adds the copies still to buy to a draft purchase order, or starts one, which shows them for the customer\'s order', async () => {
    renderPage('procurement');
    await settle();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Special Orders' }));
    const row = (await screen.findByText('ORD-20261031-0030')).closest('tr') as HTMLElement;
    expect(row.textContent).toMatch(/Abebe Kebede.*Yegna Tarik.*2/);
    await user.click(within(row).getByLabelText('Buy Yegna Tarik for ORD-20261031-0030'));
    await user.selectOptions(screen.getByLabelText('Draft purchase order'), '7');
    await user.click(screen.getByRole('button', { name: 'Add to purchase order' }));
    await settle();
    expect(sent('POST', '/purchase-orders/7/special-orders')).toEqual([{ lines: [{ orderLineId: 51, quantity: 2 }] }]);
    // The purchase order opens, its copies for the customer shown.
    expect(await screen.findByText(/2 for ORD-20261031-0030/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Back/ }));
    await user.click(await screen.findByRole('button', { name: 'Special Orders' }));
    const again = (await screen.findByText('ORD-20261031-0030')).closest('tr') as HTMLElement;
    await user.click(within(again).getByLabelText('Buy Yegna Tarik for ORD-20261031-0030'));
    await user.click(screen.getByLabelText('A new draft for a supplier'));
    await user.click(screen.getByPlaceholderText('Type to search suppliers…'));
    await user.click(await screen.findByRole('option', { name: 'Acme Distributors' }));
    await user.type(within(again).getByLabelText('Unit cost of Yegna Tarik'), '30');
    await user.click(screen.getByRole('button', { name: 'Create draft purchase order' }));
    await settle();
    expect(sent('POST', '/purchase-orders')).toEqual([{ supplierId: 3, specialOrders: [{ orderLineId: 51, quantity: 2, unitCost: '30' }] }]);
  });

  it('takes a deposit when a credit order is confirmed from the list', async () => {
    current = order({ status: 'DRAFT', paymentStatus: 'unpaid', amountPaid: 0, allowedActions: ['edit', 'confirm', 'cancel'] });
    renderPage('orders');
    await settle();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Confirm (set due date)' }));
    await user.type(screen.getByLabelText('Due date'), '2099-12-31');
    await user.type(screen.getByLabelText('Deposit (optional)'), '15');
    await user.selectOptions(screen.getByLabelText('Payment method'), 'mobile');
    await user.type(screen.getByLabelText(/Telebirr/i), 'TB12345678');
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await settle();
    expect(sent('POST', '/orders/30/confirm')).toEqual([{ dueDate: '2099-12-31', deposit: 15, paymentMethod: 'mobile', transactionReference: 'TB12345678' }]);
  });

  it('is not offered to roles that do not buy', async () => {
    me = profile(['Stock_Clerk']);
    stubApi();
    renderPage('procurement');
    await settle();
    expect(screen.queryByRole('button', { name: 'Special Orders' })).toBeNull();
  });
});
