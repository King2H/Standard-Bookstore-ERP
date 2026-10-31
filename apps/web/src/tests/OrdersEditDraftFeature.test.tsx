// #174 PR 1 (owner decision 1a, 2026-10-31): a draft order is edited until it
// is confirmed. The list offers Edit where the API allows it; the order form
// opens the draft as it was entered (customer, sale type, location, lines and
// how each discount was given) and saves it, or saves and confirms it. Before,
// a draft could only be cancelled and created again. Every mocked answer is
// checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CustomerSchema, EffectiveConfigResponseSchema,
  LocationListResponseSchema, OrderListResponseSchema, OrderSchema, ProfileResponseSchema,
  type Book, type Customer, type Order, type ProfileResponse,
} from '@bms/shared';
import OrdersPage from '../features/orders/pages/OrdersPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-18T07:00:00.000Z';

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
  id: 5, branchId: 1, customerCode: 'CUS-0005', fullName: 'Credit Customer', phone: null, email: null, gender: null,
  dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
  loyaltyBalance: 0, lifetimePoints: 0, storeCreditBalance: 20, outstandingReceivables: 0, groups: [],
});

function order(over: Partial<Order> = {}): Order {
  return contract(OrderSchema, {
    id: '20', orderNumber: 'ORD-20261018-0020', customerId: null, branchId: 1, locationId: 7, channel: 'in_store',
    status: 'DRAFT', paymentStatus: 'unpaid', amountPaid: 0, saleType: 'cash_sale', currency: 'ETB', subtotal: 30, discountAmount: 0,
    discountTotal: 0, taxRate: 0, taxAmount: 0, total: 30, cancelReason: null, notes: null, createdBy: 9,
    createdAt: CREATED, updatedAt: CREATED, allowedActions: [], paymentMethod: null, dueDate: null, fulfilledAt: null,
    ...over,
  });
}

const DRAFT = order({
  customerId: 5, notes: 'Call first', subtotal: 54, discountAmount: 6, discountTotal: 6, total: 54,
  allowedActions: ['edit', 'confirm', 'cancel'],
  lineItems: [{
    id: '41', orderId: '20', bookId: 9, bookTitle: 'Fikir Eske Mekabir', bookIsbn: '9780306406109', quantity: 2, unitPrice: 30,
    discountAmount: 6, totalPrice: 54, discountType: 'Merchant', discountMode: 'Percentage', discountPct: 10,
    qtyReserved: 0, qtyFulfilled: 0, isBackordered: false, unitCost: null, qtyReturned: 0, qtyCancelled: 0, specialOrder: false, qtyOnOrder: 0, service: null,
  }],
});

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let listed: Order;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, {
        items: [{ id: 7, branchId: 1, name: 'Main Store', isDefaultFulfillment: true, createdAt: CREATED }], total: 1, accessMode: 'full',
      }));
    }
    if (u.pathname === '/config/effective') {
      const values: Record<string, unknown> = { max_line_discount_pct: { Sales: 10, Manager: 25 } };
      const keys = (u.searchParams.get('keys') ?? '').split(',').filter((k) => k in values);
      return json(contract(EffectiveConfigResponseSchema, { items: keys.map((key) => ({ key, value: values[key], source: 'system' as const })) }));
    }
    if (u.pathname === '/books/with-availability') {
      return json(contract(BookAvailabilityListResponseSchema, {
        items: [{ ...book(9, 'Fikir Eske Mekabir', 30), availability: { locationId: 7, locationName: 'Main Store', onHand: 10, reserved: 0, available: 10 } }],
        total: 1, page: 1, pageSize: 8, totalPages: 1,
      }));
    }
    if (u.pathname === '/customers/5') return json(contract(CustomerSchema, customer));
    if (u.pathname === '/orders/20' && method === 'GET') return json(contract(OrderSchema, DRAFT));
    if (u.pathname === '/orders/20' && method === 'PUT') return json(contract(OrderSchema, DRAFT));
    if (method === 'POST' && u.pathname === '/orders/20/confirm') return json(contract(OrderSchema, order({ status: 'CONFIRMED' })));
    if (u.pathname === '/orders') {
      const summary = { ...listed, lineItems: undefined };
      return json(contract(OrderListResponseSchema, { items: [summary], total: 1, page: 1, pageSize: 10, totalPages: 1 }));
    }
    if (u.pathname.includes('/bank-accounts')) return new Response('{}', { status: 404 });
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body as Record<string, unknown>);

async function openList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><OrdersPage /></ToastProvider></QueryClientProvider>);
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Orders$/ }));
  await screen.findByText('ORD-20261018-0020');
  await settle();
  return user;
}

async function editDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('heading', { name: 'Editing ORD-20261018-0020' });
  await screen.findByText('Credit Customer (CUS-0005)');
  await settle();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  listed = DRAFT;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('Orders: editing a draft (#174, decision 1a)', () => {
  it('opens the draft as it was entered (was: no way to change a draft)', async () => {
    const user = await openList();
    await editDraft(user);
    expect(screen.getByLabelText('Discount on Fikir Eske Mekabir')).toHaveValue(10);
    expect(screen.getByLabelText('Discount type for Fikir Eske Mekabir')).toHaveValue('Merchant');
    expect(screen.getByLabelText('Quantity of Fikir Eske Mekabir')).toHaveTextContent('2');
  });

  it('saves the changed draft without a new order', async () => {
    const user = await openList();
    await editDraft(user);
    await user.click(screen.getByRole('button', { name: 'One more Fikir Eske Mekabir' }));
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => expect(sent('PUT', '/orders/20')).toEqual([{
      customerId: 5, channel: 'in_store', saleType: 'cash_sale', locationId: 7, notes: 'Call first',
      items: [{ bookId: 9, quantity: 3, discountPct: 10, discountType: 'Merchant', discountMode: 'Percentage' }],
    }]));
    expect(sent('POST', '/orders')).toEqual([]);
    expect(sent('POST', '/orders/20/confirm')).toEqual([]);
  });

  it('saves and confirms it, paid now', async () => {
    const user = await openList();
    await editDraft(user);
    await user.click(screen.getByRole('button', { name: 'Save & Confirm' }));
    await waitFor(() => expect(sent('POST', '/orders/20/confirm')).toEqual([{ paymentMethod: 'cash' }]));
    expect(sent('PUT', '/orders/20')).toHaveLength(1);
    expect(sent('POST', '/orders')).toEqual([]);
  });

  it('is not offered where the API offers no edit', async () => {
    listed = order({ status: 'CONFIRMED', allowedActions: ['cancel'] });
    await openList();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
