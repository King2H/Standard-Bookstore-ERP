// #23 (M6, step 4): Returns move to features/returns. The page offers only
// what the API accepts, by any role held in the branch (owner decision 1a),
// names the sale by its number, and lets damaged books be kept apart (2a).
// #166: a delivered customer order is returned here too, by its ORD- number.
// Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  OrderListResponseSchema, OrderSchema, PosTransactionListResponseSchema, PosTransactionSchema, ProfileResponseSchema,
  ReturnListResponseSchema, ReturnSchema, type Order, type PosTransaction, type ProfileResponse, type Return,
} from '@bms/shared';
import ReturnsPage from '../features/returns/pages/ReturnsPage.js';
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

const sale: PosTransaction = contract(PosTransactionSchema, {
  id: '41', branchId: 1, locationId: 7, customerId: null, staffId: 9, transactionNumber: 'POS-20261010-0001',
  subtotal: 30, discountTotal: 1, taxTotal: 0, grandTotal: 29, amountPaid: 29, amountDue: 0, paymentStatus: 'paid',
  currency: 'ETB', status: 'completed', createdAt: CREATED, dueDate: null, voidable: false,
  lineItems: [{
    id: '7', transactionId: '41', bookId: 1, bookTitle: 'Fikir Eske Mekabir', bookIsbn: '1', quantity: 3,
    unitPrice: 10, discountPct: 0, discountAmount: 1, lineTotal: 29, unitCost: null, service: null,
  }],
});

const ret: Return = contract(ReturnSchema, {
  id: '5', returnNumber: 'RET-20261010-0001', transactionId: '41', transactionNumber: 'POS-20261010-0001', branchId: 1,
  customerId: null, totalRefundAmount: 29, refundMethod: 'mixed', status: 'completed', reason: null,
  processedBy: 9, approvedBy: null, undelivered: false, createdAt: CREATED, orderId: null, orderNumber: null, exchangeId: null, exchangeReference: null,
});

const DELIVERED = '2026-10-19T09:00:00.000Z';
let delivered: Order;
const deliveredOrder = (over: Partial<Order> = {}): Order => contract(OrderSchema, {
  id: '30', orderNumber: 'ORD-20261018-0003', customerId: 5, branchId: 1, locationId: 7, channel: 'in_store',
  status: 'COMPLETED', paymentStatus: 'paid', amountPaid: 75, saleType: 'cash_sale', currency: 'ETB', subtotal: 75, discountAmount: 0,
  discountTotal: 0, taxRate: 0, taxAmount: 0, total: 75, cancelReason: null, notes: null, createdBy: 9,
  createdAt: CREATED, updatedAt: CREATED, allowedActions: ['print', 'return'], paymentMethod: 'cash', dueDate: null, fulfilledAt: DELIVERED,
  lineItems: [{
    id: '8', orderId: '30', bookId: 1, bookTitle: 'Oromay', bookIsbn: '2', quantity: 3, unitPrice: 25, discountAmount: 0,
    totalPrice: 75, discountType: 'Normal', discountMode: 'Amount', discountPct: 0, qtyReserved: 0, qtyFulfilled: 3, isBackordered: false, unitCost: 10, qtyReturned: 1, qtyCancelled: 0, service: null,
  }],
  ...over,
});
const orderReturn: Return = contract(ReturnSchema, {
  ...ret, id: '6', returnNumber: 'RET-20261019-0001', transactionId: null, transactionNumber: null,
  orderId: '30', orderNumber: 'ORD-20261018-0003', totalRefundAmount: 50, refundMethod: 'cash',
});

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/pos/transactions') {
      return json(contract(PosTransactionListResponseSchema, { items: [{ ...sale, lineItems: undefined }], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/pos/transactions/41') return json(sale);
    if (u.pathname === '/orders') {
      const found = u.searchParams.get('orderNumber') === delivered.orderNumber ? [{ ...delivered, lineItems: undefined }] : [];
      return json(contract(OrderListResponseSchema, { items: found, total: found.length, page: 1, pageSize: 1, totalPages: 1 }));
    }
    if (u.pathname === '/orders/30') return json(delivered);
    if (method === 'POST' && u.pathname === '/returns') return json(ret, 201);
    if (u.pathname === '/returns') return json(contract(ReturnListResponseSchema, { items: [ret, orderReturn], total: 2, page: 1, totalPages: 1 }));
    if (u.pathname === '/returns/5') {
      return json(contract(ReturnSchema, {
        ...ret,
        lineItems: [{ id: '1', returnId: '5', transactionLineItemId: '7', orderLineItemId: null, exchangeLineItemId: null, bookId: 1, bookTitle: 'Fikir Eske Mekabir', quantity: 3, unitPrice: 10, lineRefundAmount: 29 }],
        refunds: [
          { id: '1', returnId: '5', method: 'credit_note', amount: 20, createdAt: CREATED },
          { id: '2', returnId: '5', method: 'mobile', amount: 9, createdAt: CREATED },
        ],
      }));
    }
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function openPage(initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><ReturnsPage initialContext={initialContext} /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
}

async function pickSale(number = 'POS-20261010-0001') {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Transaction or order number' }), number);
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.click(await screen.findByRole('button', { name: /Use this transaction/ }));
  await settle();
  return user;
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  delivered = deliveredOrder();
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('New Return', () => {
  it('sends no refund method and values lines from what they cost after discount', async () => {
    await openPage();
    const user = await pickSale();

    expect(screen.queryByRole('button', { name: /Store Credit/ })).not.toBeInTheDocument();
    const qty = screen.getByRole('spinbutton');
    await user.clear(qty);
    await user.type(qty, '3');
    expect(screen.getAllByText(/29\.00/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/returns');
    expect(post?.body).toEqual({ transactionId: 41, lines: [{ transactionLineItemId: 7, quantity: 3, disposition: 'SELLABLE' }] });
  });

  it('keeps a book marked damaged apart from the stock for sale (was: always back on the shelf)', async () => {
    await openPage();
    const user = await pickSale();
    const qty = screen.getByRole('spinbutton');
    await user.clear(qty);
    await user.type(qty, '1');
    await user.click(screen.getByRole('checkbox', { name: 'Damaged' }));

    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      transactionId: 41, lines: [{ transactionLineItemId: 7, quantity: 1, disposition: 'DAMAGED' }],
    });
  });

  it('tells a Manager by any role held that they may approve (was: only by the main role)', async () => {
    me = profile(['Sales', 'Manager']);
    await openPage();
    await pickSale();
    expect(screen.getByText('✓ Manager/Admin Approval')).toBeInTheDocument();
    expect(screen.getByText(/As Manager, you can process returns above the approval limit/)).toBeInTheDocument();
    expect(screen.queryByText('⚠ Approval Policy')).not.toBeInTheDocument();
  });

  it('does not offer Process Return to a Finance_Officer, whom the API refuses (was: offered)', async () => {
    me = profile(['Finance_Officer']);
    await openPage();
    await pickSale();
    expect(screen.getByText('Step 3 — Refund Details')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Process Return' })).not.toBeInTheDocument();
  });
});

describe('Returning a customer order (#166)', () => {
  it('finds a delivered order by its ORD- number and returns what is left of its lines (was: POS sales only)', async () => {
    await openPage();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Transaction or order number' }), 'ORD-20261018-0003');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: /Use this order/ }));
    await settle();

    expect(calls.some((c) => c.path.startsWith('/orders?') && c.path.includes('orderNumber=ORD-20261018-0003'))).toBe(true);
    expect(screen.getByText(/3 delivered · 1 returned/)).toBeInTheDocument();
    const qty = screen.getByRole('spinbutton');
    expect(qty).toHaveAttribute('max', '2');
    await user.clear(qty);
    await user.type(qty, '2');
    expect(screen.getAllByText(/50\.00/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      orderId: 30, lines: [{ orderLineItemId: 8, quantity: 2, disposition: 'SELLABLE' }],
    });
  });

  it("opens on the order an order's Return action names", async () => {
    await openPage({ sale: 'ORD-20261018-0003' });
    expect(await screen.findByRole('button', { name: /Use this order/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Transaction or order number' })).toHaveValue('ORD-20261018-0003');
  });

  it('returns what a part-delivered order handed over, not what it did not (#174; was: refused as not delivered)', async () => {
    const base = deliveredOrder();
    delivered = deliveredOrder({
      status: 'PART_DELIVERED', allowedActions: ['deliver', 'return'],
      lineItems: base.lineItems!.map((l) => ({ ...l, qtyFulfilled: 2, qtyReserved: 1, qtyReturned: 0 })),
    });
    await openPage({ sale: 'ORD-20261018-0003' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Use this order/ }));
    await settle();
    expect(screen.getByText(/3 ordered, 2 delivered/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveAttribute('max', '2');
  });

  it('sends an order not delivered yet to be cancelled instead (2a)', async () => {
    delivered = deliveredOrder({ status: 'CONFIRMED', fulfilledAt: null, allowedActions: ['cancel', 'fulfill'] });
    await openPage({ sale: 'ORD-20261018-0003' });
    expect(await screen.findByText(/was not delivered: cancel it in Orders/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use this order/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Step 3 — Refund Details')).not.toBeInTheDocument();
  });
});

describe('Returns History', () => {
  it('names an order return by the order number', async () => {
    await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Returns History/ }));
    const row = (await screen.findByText('RET-20261019-0001')).closest('tr') as HTMLElement;
    expect(within(row).getByText('ORD-20261018-0003')).toBeInTheDocument();
  });

  it('names the sale by its number and leaves the branch to the session (was: the internal id, and the branch sent from the client)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Returns History/ }));
    const row = (await screen.findByText('RET-20261010-0001')).closest('tr') as HTMLElement;

    expect(within(row).getByText('POS-20261010-0001')).toBeInTheDocument();
    expect(within(row).queryByText('#41')).not.toBeInTheDocument();
    const list = calls.find((c) => c.path.startsWith('/returns?'));
    expect(list?.path).not.toContain('branchId');
    // Each row and its detail are keyed (was: React's missing-key warning).
    expect(errors.mock.calls.some((args) => String(args[0]).includes('unique "key"'))).toBe(false);
    errors.mockRestore();
  });

  it('lists returns without a Reject action and shows how each was refunded', async () => {
    await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Returns History/ }));
    await user.click(await screen.findByText('RET-20261010-0001'));

    expect(screen.getByText('Mixed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(await screen.findByText(/Credit Note: .*20\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Telebirr: .*9\.00/)).toBeInTheDocument();
  });
});
