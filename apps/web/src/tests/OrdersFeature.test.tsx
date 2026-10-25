// #23 (M6, step 4): Orders part 1, the list and its steps, move to
// features/orders. Steps are offered as the API allows them, by any role held;
// cancel asks its reason and delete its confirmation in the app's dialog
// (owner decision 2a); Print prints an order slip only (1a); the list leaves
// the branch to the session. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CustomerSchema, OrderListResponseSchema, OrderSchema, ProfileResponseSchema, ReturnListResponseSchema,
  type Order, type ProfileResponse,
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

function order(over: Partial<Order> = {}): Order {
  return contract(OrderSchema, {
    id: '10', orderNumber: 'ORD-20261018-0001', customerId: null, branchId: 1, locationId: 7, channel: 'in_store',
    status: 'CONFIRMED', paymentStatus: 'paid', amountPaid: 0, saleType: 'cash_sale', currency: 'ETB', subtotal: 50, discountAmount: 0,
    discountTotal: 0, taxRate: 0, taxAmount: 0, total: 50, cancelReason: null, notes: null, createdBy: 9,
    createdAt: CREATED, updatedAt: CREATED, allowedActions: [], paymentMethod: 'cash', dueDate: null, fulfilledAt: null,
    ...over,
  });
}

const LINE = {
  id: 'li1', orderId: '10', bookId: 1, bookTitle: 'Fikir Eske Mekabir', bookIsbn: '000', quantity: 2, unitPrice: 25,
  discountAmount: 0, totalPrice: 50, qtyReserved: 2, qtyFulfilled: 0, isBackordered: false, unitCost: null, qtyReturned: 0, service: null,
};
let line = LINE;

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let orders: Order[];
let total: number;
let bankAccountsOn: boolean;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/orders' && method === 'GET') {
      const page = Number(u.searchParams.get('page') ?? 1);
      const pageSize = Number(u.searchParams.get('pageSize') ?? 10);
      return json(contract(OrderListResponseSchema, {
        items: orders, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }));
    }
    const one = u.pathname.match(/^\/orders\/(\w+)$/);
    if (one && method === 'GET') return json(order({ ...orders.find((o) => o.id === one[1]), lineItems: [line] }));
    if (u.pathname === '/returns') {
      return json(contract(ReturnListResponseSchema, {
        items: u.searchParams.get('orderId') === '10' ? [{
          id: '5', returnNumber: 'RET-20261019-0001', transactionId: null, transactionNumber: null, orderId: '10',
          orderNumber: 'ORD-20261018-0001', branchId: 1, customerId: null, totalRefundAmount: 25, refundMethod: 'cash',
          status: 'completed', reason: null, processedBy: 9, approvedBy: null, createdAt: CREATED,
        }] : [],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (one && method === 'DELETE') return new Response(null, { status: 204 });
    if (method === 'POST' && /^\/orders\/\w+\/(confirm|cancel|fulfill)$/.test(u.pathname)) return json(order());
    if (u.pathname === '/customers/5') {
      return json(contract(CustomerSchema, {
        id: 5, branchId: 1, customerCode: 'CUS-0005', fullName: 'Abebe Kebede', phone: null, email: null, gender: null,
        dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
        loyaltyBalance: 0, lifetimePoints: 0, storeCreditBalance: 0, outstandingReceivables: 0, groups: [],
      }));
    }
    if (u.pathname.includes('/bank-accounts')) {
      return bankAccountsOn
        ? json({ items: [{ id: 3, accountName: 'Main', bankName: 'CBE', accountNumberMasked: '****1234', currency: 'ETB' }] })
        : new Response('{}', { status: 404 });
    }
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const listCalls = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/orders?')).map((c) => c.path);

async function openPage(onNavigate = vi.fn(), initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><OrdersPage initialContext={initialContext} onNavigate={onNavigate} /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  return { onNavigate, user: userEvent.setup() };
}

const rowOf = async (number = 'ORD-20261018-0001') => (await screen.findByText(number)).closest('tr') as HTMLElement;

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  orders = [order()];
  total = 1;
  bankAccountsOn = false;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the list', () => {
  it('pages through the orders, and leaves the branch to the session (was: the branch sent from the client)', async () => {
    total = 25;
    orders = Array.from({ length: 10 }, (_, i) => order({ id: String(i + 1), orderNumber: `ORD-${i + 1}` }));
    const { user } = await openPage();
    expect(await screen.findByText(/Showing 1–10 of 25 orders/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => expect(listCalls().some((p) => p.includes('page=2') && p.includes('pageSize=10'))).toBe(true));
    expect(listCalls().every((p) => !p.includes('branchId'))).toBe(true);
  });

  it('offers only the statuses an order can have now, and a filter goes back to page 1 (was: 7 statuses no order has)', async () => {
    const { user } = await openPage();
    await rowOf();
    const select = screen.getByLabelText('Status');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', 'Confirmed,In_Progress,CONFIRMED,PAID', 'DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED']);

    await user.selectOptions(select, 'CANCELLED');
    await waitFor(() => expect(listCalls().some((p) => p.includes('status=CANCELLED') && p.includes('page=1'))).toBe(true));
  });

  it("opens the Dashboard's Pending Orders on its status", async () => {
    await openPage(vi.fn(), { status: 'Confirmed,In_Progress,CONFIRMED,PAID' });
    await rowOf();
    expect(screen.getByLabelText('Status')).toHaveValue('Confirmed,In_Progress,CONFIRMED,PAID');
    expect(listCalls()[0]).toContain('status=Confirmed%2CIn_Progress%2CCONFIRMED%2CPAID');
  });

  it("shows an order's payment method and due date when opened", async () => {
    orders = [order({ saleType: 'credit_sale', paymentStatus: 'unpaid', paymentMethod: null, dueDate: '2099-12-31', customerId: 5 })];
    const { user } = await openPage();
    await user.click(await screen.findByText('ORD-20261018-0001'));
    expect(await screen.findByText('2099-12-31')).toBeInTheDocument();
    expect(screen.getByText(/Due date/)).toBeInTheDocument();
    expect(screen.getByText('🔒 Stock reserved')).toBeInTheDocument();
  });

  it('opens Payments for an order with something to collect, and not for a paid one', async () => {
    orders = [
      order({ id: '20', orderNumber: 'ORD-20', saleType: 'credit_sale', paymentStatus: 'unpaid' }),
      order({ id: '21', orderNumber: 'ORD-21', saleType: 'credit_sale', paymentStatus: 'partial' }),
      order({ id: '22', orderNumber: 'ORD-22' }),
    ];
    const { user, onNavigate } = await openPage();
    await user.click(within(await rowOf('ORD-20')).getByRole('button', { name: /View Payments/i }));
    expect(onNavigate).toHaveBeenCalledWith('payments', { orderId: '20', sourceType: 'order' });
    expect(within(await rowOf('ORD-21')).getByRole('button', { name: /View Payments/i })).toBeInTheDocument();
    expect(within(await rowOf('ORD-22')).queryByRole('button', { name: /View Payments/i })).not.toBeInTheDocument();
  });
});

describe('steps on an order', () => {
  it('confirms a cash draft with its payment method, proof and bank account', async () => {
    bankAccountsOn = true;
    orders = [order({ status: 'DRAFT', paymentStatus: 'unpaid', paymentMethod: null, allowedActions: ['confirm', 'cancel'] })];
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: /Confirm \(set payment method\)/i }));
    const row = await rowOf();
    const ok = within(row).getByRole('button', { name: 'OK' });
    expect(ok).toBeDisabled();
    await user.selectOptions(within(row).getByLabelText('Payment method'), 'bank');
    await user.click(ok);
    expect(posted('/orders/10/confirm')).toHaveLength(0);
    await user.type(within(row).getByLabelText("Customer's bank"), 'Awash Bank');
    await user.type(within(row).getByLabelText('Transfer reference'), 'FT24001');
    await user.click(ok);
    expect(posted('/orders/10/confirm')).toHaveLength(0);
    await user.selectOptions(within(row).getByLabelText('Bank account'), '3');
    await user.click(ok);
    await waitFor(() => expect(posted('/orders/10/confirm')).toEqual([
      { paymentMethod: 'bank', payerBank: 'Awash Bank', transactionReference: 'FT24001', bankAccountId: 3 },
    ]));
  });

  it("confirms a credit draft with a due date of today or later, as the API counts today", async () => {
    orders = [order({ status: 'DRAFT', saleType: 'credit_sale', paymentStatus: 'unpaid', paymentMethod: null, customerId: 5, allowedActions: ['confirm', 'cancel'] })];
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: /Confirm \(set due date\)/i }));
    const due = screen.getByLabelText('Due date') as HTMLInputElement;
    expect(due.min).toBe(new Date().toISOString().slice(0, 10));
    await user.type(due, '2099-12-31');
    await user.click(within(await rowOf()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(posted('/orders/10/confirm')).toEqual([{ dueDate: '2099-12-31' }]));
  });

  it("asks the reason for cancelling in the app's dialog and sends it (was: an empty reason sent as 'No reason')", async () => {
    orders = [order({ allowedActions: ['cancel', 'fulfill'] })];
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Order' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    expect(posted('/orders/10/cancel')).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox'), 'Customer changed mind');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Order' }));
    await waitFor(() => expect(posted('/orders/10/cancel')).toEqual([{ reason: 'Customer changed mind' }]));
  });

  it('says what a paid order took and asks how it goes back, then sends it (#167; was: the money kept, nothing owed back)', async () => {
    orders = [order({ amountPaid: 50, customerId: 5, allowedActions: ['cancel', 'fulfill'] })];
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('It took ETB 50.00, which goes back now.');
    expect(within(dialog).getByRole('radio', { name: 'Refund the way it was paid' })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: 'Store credit for the customer' }));
    await user.type(within(dialog).getByRole('textbox'), 'Customer withdrew');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Order' }));
    await waitFor(() => expect(posted('/orders/10/cancel')).toEqual([{ reason: 'Customer withdrew', refundTo: 'store_credit' }]));
  });

  it('offers store credit only for an order with a customer', async () => {
    orders = [order({ amountPaid: 50, customerId: null, allowedActions: ['cancel', 'fulfill'] })];
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('radio').map((r) => r.closest('label')?.textContent?.trim())).toEqual(['Refund the way it was paid']);
    await user.type(within(dialog).getByRole('textbox'), 'Walk-in left');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Order' }));
    await waitFor(() => expect(posted('/orders/10/cancel')).toEqual([{ reason: 'Walk-in left', refundTo: 'original' }]));
  });

  it('fulfils a confirmed order', async () => {
    orders = [order({ allowedActions: ['cancel', 'fulfill'] })];
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: 'Fulfill' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/orders/10/fulfill')).toBe(true));
  });

  it('offers no button for a step the page does not know (was: one posting to an endpoint that does not exist)', async () => {
    orders = [order({ status: 'FULFILLED', allowedActions: ['archive'] })];
    await openPage();
    const row = await rowOf();
    expect(within(row).queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
  });

  it('returns a delivered order in Returns, opened on it (#166; was: no way to return an order)', async () => {
    orders = [order({ status: 'COMPLETED', allowedActions: ['print', 'return'], fulfilledAt: CREATED })];
    const { user, onNavigate } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: /Return/ }));
    expect(onNavigate).toHaveBeenCalledWith('returns', { sale: 'ORD-20261018-0001' });
  });

  it('shows what came back of a delivered order, and its returns; the order stays completed (4a)', async () => {
    orders = [order({ status: 'COMPLETED', allowedActions: ['print', 'return'], fulfilledAt: CREATED })];
    line = { ...LINE, qtyReserved: 0, qtyFulfilled: 2, qtyReturned: 1 };
    const { user } = await openPage();
    await user.click(await screen.findByText('ORD-20261018-0001'));
    expect(await screen.findByText('RET-20261019-0001')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Returned' })).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/returns?') && c.path.includes('orderId=10'))).toBe(true);
    line = LINE;
  });

  it("prints an order slip, not the whole screen (owner decision 1a)", async () => {
    orders = [order({ status: 'COMPLETED', customerId: 5, allowedActions: ['print'] })];
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: /Print/ }));
    expect(print).not.toHaveBeenCalled();

    const slip = screen.getByRole('dialog', { name: 'Order ORD-20261018-0001' });
    expect(slip).toHaveAttribute('id', 'print-slip');
    expect(await within(slip).findByText('Fikir Eske Mekabir')).toBeInTheDocument();
    expect(await within(slip).findByText('Abebe Kebede (CUS-0005)')).toBeInTheDocument();
    expect(within(slip).getAllByText('ETB 50.00')).toHaveLength(2); // subtotal and total
    await user.click(within(slip).getByRole('button', { name: /Print/ }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});

describe('deleting an order', () => {
  it('is offered to an Admin by any role held in the branch (was: only by the main role)', async () => {
    me = profile(['Sales', 'Admin']);
    orders = [order({ status: 'DRAFT', paymentStatus: 'unpaid', allowedActions: ['confirm', 'cancel'] })];
    await openPage();
    expect(within(await rowOf()).getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('is not offered to Sales', async () => {
    orders = [order({ status: 'DRAFT', paymentStatus: 'unpaid', allowedActions: ['confirm', 'cancel'] })];
    await openPage();
    expect(within(await rowOf()).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("is asked in the app's dialog, then sent (was: the browser's confirm box)", async () => {
    me = profile(['Admin']);
    orders = [order({ status: 'CANCELLED', paymentStatus: 'unpaid' })];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = await openPage();
    await user.click(within(await rowOf()).getByRole('button', { name: /Delete/ }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete Order' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', path: '/orders/10', body: undefined }));
    confirmSpy.mockRestore();
  });
});
