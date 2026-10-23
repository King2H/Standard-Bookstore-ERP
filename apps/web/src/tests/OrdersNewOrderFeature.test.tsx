// #23 (M6, step 4): Orders part 2, the New Order form, moves to features/orders.
// It checks discounts against the API's limits and store credit against the
// balance before sending; a failed confirmation leaves one draft and a clear
// form (owner decision 3a); customers are active ones; the branch is the
// session's. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CustomerListResponseSchema, CustomerSchema, EffectiveConfigResponseSchema,
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
    createdAt: CREATED, updatedAt: CREATED, allowedActions: [], paymentMethod: null, dueDate: null,
    ...over,
  });
}

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let available: number;
let confirmFails: boolean;

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
        items: [{ ...book(9, 'Fikir Eske Mekabir', 30), availability: { locationId: 7, locationName: 'Main Store', onHand: available, reserved: 0, available } }],
        total: 1, page: 1, pageSize: 8, totalPages: 1,
      }));
    }
    if (u.pathname === '/customers') return json(contract(CustomerListResponseSchema, { items: [customer], total: 1, page: 1, totalPages: 1 }));
    if (method === 'POST' && u.pathname === '/orders') return json(order({ saleType: body.saleType, customerId: body.customerId }), 201);
    if (method === 'POST' && u.pathname === '/orders/20/confirm') {
      if (confirmFails) return json({ error: 'INSUFFICIENT_STOCK', message: 'Not enough stock for Fikir Eske Mekabir.' }, 422);
      return json(order({ status: 'CONFIRMED' }));
    }
    if (u.pathname === '/orders') return json(contract(OrderListResponseSchema, { items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 }));
    if (u.pathname.includes('/bank-accounts')) return new Response('{}', { status: 404 });
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body as Record<string, unknown>);

async function openForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><OrdersPage /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /New Order/i }));
  await settle();
  return user;
}

async function addBook(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Search books to add...'), 'Fikir');
  await user.click(await screen.findByText('Fikir Eske Mekabir'));
}

async function pickCustomer(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Search customer...'), 'Credit');
  await user.click(await screen.findByText('Credit Customer'));
}

async function setDiscount(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = screen.getByLabelText('Discount on Fikir Eske Mekabir');
  await user.clear(input);
  await user.type(input, value);
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  available = 10;
  confirmFails = false;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('stock', () => {
  it("cannot take more than the book's available stock", async () => {
    available = 2;
    const user = await openForm();
    await addBook(user);
    const plus = screen.getByRole('button', { name: '+' });
    await user.click(plus);
    await waitFor(() => expect(plus).toBeDisabled());
    expect(screen.getByText('2', { selector: 'span' })).toBeInTheDocument();
  });

  it('refuses an out-of-stock book', async () => {
    available = 0;
    const user = await openForm();
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Fikir');
    expect((await screen.findByText('Fikir Eske Mekabir')).closest('button')).toBeDisabled();
  });

  it("searches at the branch's location, leaving the branch to the session (was: the branch sent from the client)", async () => {
    const user = await openForm();
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Fikir');
    expect(await screen.findByText('10 avail')).toBeInTheDocument();
    const search = calls.find((c) => c.path.startsWith('/books/with-availability'));
    expect(search?.path).toContain('locationId=7');
    expect(search?.path).not.toContain('branchId');
  });
});

describe('create and confirm', () => {
  it('creates a cash order and confirms it with its payment method and proof', async () => {
    const user = await openForm();
    await addBook(user);
    await user.click(screen.getByText('Telebirr'));
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(posted('/orders')).toHaveLength(0);
    await user.type(screen.getByLabelText('Telebirr transaction number'), ' TB-77 ');
    await user.click(screen.getByRole('button', { name: /Create Order/i }));

    await waitFor(() => expect(posted('/orders/20/confirm')).toEqual([{ paymentMethod: 'mobile', transactionReference: 'TB-77' }]));
    expect(posted('/orders')[0]).toMatchObject({ saleType: 'cash_sale', locationId: 7, items: [{ bookId: 9, quantity: 1, discountPct: 0, discountMode: 'Percentage', discountType: 'Normal' }] });
    expect(posted('/orders')[0]).not.toHaveProperty('paymentMethod');
  });

  it('creates a credit order and confirms it with its due date, and refuses one without', async () => {
    const user = await openForm();
    await pickCustomer(user);
    await user.click(screen.getByRole('button', { name: /Credit Sale/i }));
    await addBook(user);
    expect(screen.queryByText('Telebirr')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(posted('/orders')).toHaveLength(0);

    await user.type(screen.getByLabelText('Due date'), '2099-12-31');
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    await waitFor(() => expect(posted('/orders/20/confirm')).toEqual([{ dueDate: '2099-12-31' }]));
    expect(posted('/orders')[0]).toMatchObject({ saleType: 'credit_sale', customerId: 5 });
    expect(posted('/orders')[0]).not.toHaveProperty('dueDate');
  });

  it('keeps the order as a draft when confirming fails, and clears the form so a retry cannot make a second one (was: the form kept its lines)', async () => {
    confirmFails = true;
    const user = await openForm();
    await addBook(user);
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(await screen.findByText(/ORD-20261018-0020 was saved as a draft: Not enough stock/)).toBeInTheDocument();
    expect(posted('/orders')).toHaveLength(1);
    // Back on the list, where the draft is; the form starts empty.
    expect(await screen.findByRole('columnheader', { name: 'Order #' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New Order/i }));
    expect(screen.queryByText('Fikir Eske Mekabir')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Order/i })).toBeDisabled();
  });
});

describe('checked before sending', () => {
  it("refuses a discount above the person's limit (was: sent, refused by the API)", async () => {
    const user = await openForm();
    await addBook(user);
    await setDiscount(user, '15');
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(await screen.findByText(/The discount on "Fikir Eske Mekabir" is more than your limit of 10%/)).toBeInTheDocument();
    expect(posted('/orders')).toHaveLength(0);
  });

  it('allows a Manager by any role held their higher limit', async () => {
    me = profile(['Sales', 'Manager']);
    const user = await openForm();
    await addBook(user);
    await setDiscount(user, '15');
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    await waitFor(() => expect(posted('/orders')).toHaveLength(1));
    expect(posted('/orders')[0]).toMatchObject({ items: [expect.objectContaining({ discountPct: 15 })] });
  });

  it('refuses an amount discount in fractions of a cent or above the line (was: sent as typed)', async () => {
    me = profile(['Admin']);
    const user = await openForm();
    await addBook(user);
    await user.click(screen.getByRole('button', { name: 'Discount as an amount' }));
    await setDiscount(user, '2.555');
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(await screen.findByText(/Enter the discount on "Fikir Eske Mekabir" as a number with at most two decimals/)).toBeInTheDocument();
    await setDiscount(user, '31');
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(await screen.findByText(/is more than the line is worth/)).toBeInTheDocument();
    expect(posted('/orders')).toHaveLength(0);
  });

  it('refuses paying with more store credit than the customer has (was: sent, refused by the API)', async () => {
    const user = await openForm();
    await pickCustomer(user);
    await addBook(user);
    await user.click(screen.getByText('Store Credit'));
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(await screen.findByText('Only 20.00 of store credit is available')).toBeInTheDocument();
    expect(posted('/orders')).toHaveLength(0);
  });

  it('offers active customers only (was: any customer, refused by the API when inactive)', async () => {
    const user = await openForm();
    await pickCustomer(user);
    expect(calls.find((c) => c.path.startsWith('/customers?'))?.path).toContain('status=active');
  });
});
