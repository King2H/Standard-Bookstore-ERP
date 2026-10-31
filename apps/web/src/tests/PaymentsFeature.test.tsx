// #23 (M6, step 4): Payments moves to features/payments. A debt is collected
// through the endpoint of its source with the methods that endpoint takes
// (owner decision 2a); store credit and points are checked against the
// balances of the customer who owes it (1a); a refund asks its amount and
// reason in a dialog (3a). Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CustomerSchema, OrderBalanceSchema, PaymentListResponseSchema, PaymentSchema, ProfileResponseSchema, UnpaidListResponseSchema,
  type Payment, type ProfileResponse, type UnpaidItem,
} from '@bms/shared';
import PaymentsPage from '../features/payments/pages/PaymentsPage.js';
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

function unpaid(over: Partial<UnpaidItem> = {}): UnpaidItem {
  return {
    id: '7', orderNumber: 'ORD-20261018-0007', customerName: 'Abebe Kebede', customerCode: 'CUS-0005', customerId: 5,
    total: 100, totalPaid: 70, outstanding: 30, paymentStatus: 'partial', status: 'CONFIRMED', channel: 'in_store',
    createdAt: CREATED, sourceType: 'order', ...over,
  };
}

const POS_SALE = unpaid({ orderNumber: 'TXN-20261018-0007', channel: 'POS', status: 'completed', sourceType: 'pos' });
const EXCHANGE = unpaid({ orderNumber: 'EXC-20261018-0007', channel: 'Exchange', status: 'PartiallyPaid', sourceType: 'exchange_difference' });

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: '11', paymentReference: 'PAY-20261018-0011', orderId: '7', amount: 100, currency: 'ETB', paymentMethod: 'cash',
    status: 'success', transactionReference: null, payerBank: null, notes: null, processedAt: CREATED, createdAt: CREATED,
    processedBy: 9, bankAccountId: null, sourceType: 'order', entityNumber: 'ORD-20261018-0007', orderStatus: 'CONFIRMED',
    ...over,
  };
}

const REFUND = {
  id: '3', paymentId: '11', orderId: '7', refundAmount: 40, reason: 'Overcharged', method: 'cash', bankAccountId: null,
  processedBy: 9, createdAt: CREATED,
};

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let pending: UnpaidItem[];
let history: Payment[];
let one: Payment;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/payments/unpaid-orders') {
      const entityId = u.searchParams.get('entityId');
      const sourceType = u.searchParams.get('sourceType');
      const items = entityId ? pending.filter((i) => i.id === entityId && i.sourceType === sourceType) : pending;
      return json(contract(UnpaidListResponseSchema, { items, total: items.length, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/payments' && method === 'GET') {
      return json(contract(PaymentListResponseSchema, { items: history, total: history.length, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/payments/11' && method === 'GET') return json(contract(PaymentSchema, one));
    if (u.pathname === '/orders/7/balance') {
      return json(contract(OrderBalanceSchema, { orderTotal: 100, totalPaid: 80, totalRefunded: 10, outstanding: 30, paymentStatus: 'partial' }));
    }
    if (u.pathname === '/customers/5') {
      return json(contract(CustomerSchema, {
        id: 5, branchId: 1, customerCode: 'CUS-0005', fullName: 'Abebe Kebede', phone: null, email: null, gender: null,
        dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
        loyaltyBalance: 12, lifetimePoints: 12, storeCreditBalance: 40, outstandingReceivables: 30, groups: [],
      }));
    }
    if (method === 'POST') return json({});
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const anyPost = () => calls.some((c) => c.method === 'POST');

async function openPage(initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><PaymentsPage initialContext={initialContext} /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  return userEvent.setup();
}

async function collectFor(number: string) {
  const user = await openPage();
  const row = (await screen.findByText(number)).closest('tr') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Collect/ }));
  await settle();
  return user;
}

const methodButtons = () => screen.getAllByRole('button').map((b) => b.textContent ?? '');
const amountBox = () => screen.getByLabelText(/^Amount/) as HTMLInputElement;

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  pending = [unpaid(), POS_SALE, EXCHANGE];
  history = [];
  one = payment();
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('pending payments', () => {
  it('lists an order, a POS sale and an exchange difference that share an id, and leaves the branch to the session', async () => {
    await openPage();
    expect(await screen.findByText('ORD-20261018-0007')).toBeInTheDocument();
    expect(screen.getByText('TXN-20261018-0007')).toBeInTheDocument();
    expect(screen.getByText('EXC-20261018-0007')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Collect/ })).toHaveLength(3);
    const lists = calls.filter((c) => c.path.startsWith('/payments/unpaid-orders')).map((c) => c.path);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((p) => !p.includes('branchId'))).toBe(true);
  });

  it('offers Collect only to the roles that take payments', async () => {
    me = profile(['Stock_Clerk']);
    await openPage();
    await screen.findByText('ORD-20261018-0007');
    expect(screen.queryByRole('button', { name: /Collect/ })).not.toBeInTheDocument();
  });
});

describe('collecting', () => {
  it('offers the methods each endpoint takes (was: card on a POS sale and loyalty on an exchange difference, refused)', async () => {
    await collectFor('ORD-20261018-0007');
    expect(methodButtons().some((t) => t.includes('Card'))).toBe(true);
    expect(methodButtons().some((t) => t.includes('Loyalty'))).toBe(true);
    // Store Credit and Telebirr are distinct methods.
    expect(screen.getByText('Store Credit')).toBeInTheDocument();
    expect(screen.getByText('Telebirr')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /Cancel/ }));
    await settle();
    const user = userEvent.setup();
    await user.click(within((await screen.findByText('TXN-20261018-0007')).closest('tr') as HTMLElement).getByRole('button', { name: /Collect/ }));
    expect(methodButtons().some((t) => t.includes('Card'))).toBe(false);
    expect(methodButtons().some((t) => t.includes('Loyalty'))).toBe(true);

    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    await user.click(within((await screen.findByText('EXC-20261018-0007')).closest('tr') as HTMLElement).getByRole('button', { name: /Collect/ }));
    expect(methodButtons().some((t) => t.includes('Card'))).toBe(false);
    expect(methodButtons().some((t) => t.includes('Loyalty'))).toBe(false);
  });

  it("reads store credit from the POS sale's own customer (was: looked up /orders/<the sale's id>)", async () => {
    const user = await collectFor('TXN-20261018-0007');
    await user.click(screen.getByRole('button', { name: /Store Credit/ }));
    expect(await screen.findByText(/Available Store Credit/)).toHaveTextContent('ETB 40.00');
    expect(calls.some((c) => c.path === '/customers/5')).toBe(true);
    expect(calls.some((c) => c.path.startsWith('/orders/7'))).toBe(false);

    await user.clear(amountBox());
    await user.type(amountBox(), '30');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    await waitFor(() => expect(posted('/pos/transactions/7/payment')).toEqual([{ payments: [{ method: 'store_credit', amount: 30 }] }]));
  });

  it('refuses points beyond the balance, counted one for one', async () => {
    const user = await collectFor('TXN-20261018-0007');
    await user.click(screen.getByRole('button', { name: /Loyalty/ }));
    expect(await screen.findByText(/Available Points/)).toHaveTextContent('12 pts');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    expect(await screen.findByText('Only 12 loyalty points are available')).toBeInTheDocument();
    expect(anyPost()).toBe(false);
  });

  it('checks the amount: whole cents, more than zero, at most what is outstanding (was: parseFloat, sent as typed)', async () => {
    const user = await collectFor('TXN-20261018-0007');
    expect(amountBox().value).toBe('30.00');

    await user.clear(amountBox());
    await user.type(amountBox(), '1.005');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    expect(await screen.findByText('Enter an amount more than zero, in whole cents')).toBeInTheDocument();

    await user.clear(amountBox());
    await user.type(amountBox(), '30.01');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    expect(await screen.findByText('Enter no more than the 30.00 outstanding')).toBeInTheDocument();
    expect(anyPost()).toBe(false);

    await user.clear(amountBox());
    await user.type(amountBox(), '12.50');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    await waitFor(() => expect(posted('/pos/transactions/7/payment')).toEqual([{ payments: [{ method: 'cash', amount: 12.5 }] }]));
  });

  it("takes an order's payment on /payments, showing the order's own balance", async () => {
    const user = await collectFor('ORD-20261018-0007');
    expect(await screen.findByText('Refunded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Card/ }));
    await user.type(screen.getByLabelText(/Transaction Reference/), 'SLIP-4');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    await waitFor(() => expect(posted('/payments')).toEqual([{ orderId: 7, amount: 30, paymentMethod: 'card', transactionReference: 'SLIP-4' }]));
    // Back on the pending list.
    expect(await screen.findByText('Orders & Credit Sales Awaiting Payment')).toBeInTheDocument();
  });

  it('collects an exchange difference on its receivable, with the Telebirr number required', async () => {
    const user = await openPage({ orderId: '7', sourceType: 'exchange_difference' });
    expect(await screen.findByText('🔁 Exchange Balance — Collecting Payment')).toBeInTheDocument();
    expect(amountBox().value).toBe('30.00');
    await user.click(screen.getByRole('button', { name: /Telebirr/ }));
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    expect(await screen.findByText('Enter the Telebirr transaction number')).toBeInTheDocument();
    expect(anyPost()).toBe(false);

    await user.type(screen.getByLabelText('Telebirr transaction number'), 'TB-EXC-9');
    await user.click(screen.getByRole('button', { name: /Record Payment/ }));
    await waitFor(() => expect(posted('/receivables/7/collect')).toEqual([{ amount: 30, paymentMethod: 'mobile', transactionReference: 'TB-EXC-9' }]));
  });

  it('says so when a link opens something with nothing left to collect', async () => {
    pending = [];
    await openPage({ orderId: '7', sourceType: 'pos' });
    expect(await screen.findByText(/no outstanding balance to collect/)).toBeInTheDocument();
  });
});

describe('payment history', () => {
  const openHistory = async () => {
    const user = await openPage();
    await user.click(screen.getByRole('button', { name: /Payment History/ }));
    await settle();
    return user;
  };

  it('offers only the statuses a payment can have (was: also pending and failed, which nothing writes)', async () => {
    await openHistory();
    const options = within(screen.getByLabelText('Status')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', 'success', 'refunded', 'partially_refunded']);
  });

  it('opens one row when an order payment and a POS collection share an id (was: both)', async () => {
    history = [
      payment({ transactionReference: 'ORDER-REF' }),
      payment({ paymentReference: 'PAY-POS-11', sourceType: 'pos', entityNumber: 'TXN-20261018-0007', transactionReference: 'POS-REF', orderStatus: null }),
    ];
    const user = await openHistory();
    await user.click(await screen.findByText('PAY-20261018-0011'));
    expect(screen.getByText('Tx Ref: ORDER-REF')).toBeInTheDocument();
    expect(screen.queryByText('Tx Ref: POS-REF')).not.toBeInTheDocument();
  });

  it('offers Refund to the refunding roles on order payments only', async () => {
    history = [
      payment(),
      payment({ id: '12', paymentReference: 'PAY-FULFILLED', orderStatus: 'FULFILLED' }),
      // A part-delivered order's money comes back through a return or by cancelling its rest (#174).
      payment({ id: '14', paymentReference: 'PAY-PART', orderStatus: 'PART_DELIVERED' }),
      payment({ id: '13', paymentReference: 'PAY-POS-13', sourceType: 'pos', orderStatus: null }),
    ];
    await openHistory();
    await screen.findByText('PAY-20261018-0011');
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();

    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    me = profile(['Sales', 'Finance_Officer']);
    stubApi();
    await openHistory();
    await screen.findByText('PAY-20261018-0011');
    expect(screen.getAllByRole('button', { name: 'Refund' })).toHaveLength(1);
    expect(within(screen.getByText('PAY-20261018-0011').closest('tr') as HTMLElement).getByRole('button', { name: 'Refund' })).toBeInTheDocument();
  });

  it('refunds what is left, with a reason required (was: the whole payment again, and "Refund" when no reason was typed)', async () => {
    me = profile(['Manager']);
    history = [payment({ status: 'partially_refunded' })];
    one = payment({ status: 'partially_refunded', refunds: [REFUND] });
    const user = await openHistory();
    await user.click(within((await screen.findByText('PAY-20261018-0011')).closest('tr') as HTMLElement).getByRole('button', { name: 'Refund' }));

    const dialog = await screen.findByRole('dialog', { name: 'Refund PAY-20261018-0011' });
    expect(within(dialog).getByText(/ETB 60.00 is left to refund/)).toBeInTheDocument();
    const amount = within(dialog).getByLabelText(/^Amount/) as HTMLInputElement;
    expect(amount.value).toBe('60.00');

    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();

    await user.clear(amount);
    await user.type(amount, '60.01');
    await user.type(within(dialog).getByLabelText(/Why is this payment/), 'Book was damaged');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await within(dialog).findByText('At most ETB 60.00 is left to refund')).toBeInTheDocument();
    expect(anyPost()).toBe(false);

    await user.clear(amount);
    await user.type(amount, '25');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(posted('/payments/11/refund')).toEqual([{ refundAmount: 25, reason: 'Book was damaged' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
