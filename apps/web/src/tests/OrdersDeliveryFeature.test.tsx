// #174 (owner decisions 1a–5a, 2026-10-31): an order is delivered in parts
// and what it will not deliver is cancelled. The list offers "Deliver…" (a
// dialog of every line with what is still waiting, prefilled) beside Fulfill,
// which still delivers everything; each delivery opens its note (DLV-) to
// print. A part-delivered order shows as such, counts as pending fulfilment,
// and its page lists its deliveries and what was delivered, waiting and
// cancelled. "Cancel the rest…" lists what will not be delivered and asks why
// and, when the order took money, how it goes back. Before, an order was
// delivered all at once or not at all. Every mocked answer is checked against
// its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  OrderListResponseSchema, OrderSchema, ProfileResponseSchema, ReturnListResponseSchema,
  type Order, type OrderLineItem, type ProfileResponse,
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
    id: '30', orderNumber: 'ORD-20261031-0030', customerId: 5, branchId: 1, locationId: 7, channel: 'in_store',
    status: 'CONFIRMED', paymentStatus: 'paid', amountPaid: 60, saleType: 'cash_sale', currency: 'ETB', subtotal: 60, discountAmount: 0,
    discountTotal: 0, taxRate: 0, taxAmount: 0, total: 60, cancelReason: null, notes: null, createdBy: 9,
    createdAt: CREATED, updatedAt: CREATED, allowedActions: [], paymentMethod: 'cash', dueDate: null, fulfilledAt: null, deliveries: [],
    ...over,
  });
}

const line = (id: string, bookId: number, bookTitle: string, quantity: number, over: Partial<OrderLineItem> = {}): OrderLineItem => ({
  id, orderId: '30', bookId, bookTitle, bookIsbn: '9780306406109', quantity, unitPrice: 30 / quantity, discountAmount: 0, totalPrice: 30,
  discountType: 'Normal', discountMode: 'Amount', discountPct: 0, qtyReserved: quantity, qtyFulfilled: 0, isBackordered: false,
  unitCost: 5, qtyReturned: 0, qtyCancelled: 0, service: null, ...over,
});

const CONFIRMED = order({
  allowedActions: ['cancel', 'deliver', 'fulfill'],
  lineItems: [line('51', 9, 'Fikir Eske Mekabir', 3), line('52', 10, 'Oromay', 2)],
});

const DELIVERY = {
  id: 1, deliveryNumber: 'DLV-20261031-0001', deliveredBy: 9, deliveredByName: 'Me', deliveredAt: CREATED, notes: 'Took two now',
  lines: [{ orderLineItemId: '51', bookId: 9, bookTitle: 'Fikir Eske Mekabir', quantity: 2 }],
};

const PART = order({
  status: 'PART_DELIVERED', fulfilledAt: CREATED, allowedActions: ['deliver', 'fulfill', 'cancel_rest', 'return'], deliveries: [DELIVERY],
  lineItems: [line('51', 9, 'Fikir Eske Mekabir', 3, { qtyReserved: 1, qtyFulfilled: 2 }), line('52', 10, 'Oromay', 2)],
});

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
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/orders/30' && method === 'GET') return json(contract(OrderSchema, current));
    if (method === 'POST' && u.pathname === '/orders/30/deliveries') {
      current = PART;
      return json(contract(OrderSchema, PART), 201);
    }
    if (method === 'POST' && u.pathname === '/orders/30/cancel-rest') {
      current = order({ status: 'COMPLETED', allowedActions: ['print', 'return'], deliveries: [DELIVERY] });
      return json(contract(OrderSchema, current));
    }
    if (u.pathname === '/orders') {
      return json(contract(OrderListResponseSchema, { items: [{ ...current, lineItems: undefined, deliveries: undefined }], total: 1, page: 1, pageSize: 10, totalPages: 1 }));
    }
    if (u.pathname === '/returns') return json(contract(ReturnListResponseSchema, { items: [], total: 0, page: 1, totalPages: 0 }));
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
  await screen.findByText('ORD-20261031-0030');
  await settle();
  return user;
}

describe('Delivering an order in parts, and cancelling the rest (#174)', () => {
  beforeEach(() => {
    setAccessToken('t'); setCurrentBranchId(1);
    me = profile(['Manager']);
    current = CONFIRMED;
    stubApi();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('delivers the copies entered per line, at most what is waiting, and opens the delivery note (was: all or nothing)', async () => {
    const user = await openList();
    expect(screen.getByRole('button', { name: 'Fulfill' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Deliver…' }));
    const dialog = await screen.findByRole('dialog', { name: /Deliver ORD-20261031-0030/ });
    const first = within(dialog).getByLabelText('Copies of Fikir Eske Mekabir to deliver') as HTMLInputElement;
    const second = within(dialog).getByLabelText('Copies of Oromay to deliver') as HTMLInputElement;
    expect([first.value, second.value]).toEqual(['3', '2']);
    await user.clear(first); await user.type(first, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Deliver' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Fikir Eske Mekabir: at most 3/);
    expect(sent('POST', '/orders/30/deliveries')).toEqual([]);

    await user.clear(first); await user.type(first, '2');
    await user.clear(second); await user.type(second, '0');
    await user.type(within(dialog).getByLabelText('Notes'), 'Took two now');
    await user.click(within(dialog).getByRole('button', { name: 'Deliver' }));
    await settle();
    expect(sent('POST', '/orders/30/deliveries')).toEqual([{ lines: [{ lineId: 51, quantity: 2 }], notes: 'Took two now' }]);
    const note = await screen.findByRole('dialog', { name: 'Delivery DLV-20261031-0001' });
    expect(note.textContent).toMatch(/ORD-20261031-0030/);
    expect(within(note).getByRole('row', { name: /Fikir Eske Mekabir/ }).textContent).toMatch(/2.*1/);
  });

  it('shows a part-delivered order, its deliveries and what each line delivered, waits for and cancelled', async () => {
    current = PART;
    const user = await openList();
    expect(screen.getByText('Part delivered', { selector: 'span' })).toBeTruthy();
    await user.click(screen.getByText('ORD-20261031-0030'));
    await settle();
    expect(screen.getByRole('row', { name: /^Fikir Eske Mekabir/ }).textContent).toMatch(/Fikir Eske Mekabir3.*1.*2/);
    expect(screen.getByText(/DLV-20261031-0001/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delivery note DLV-20261031-0001' }));
    expect(await screen.findByRole('dialog', { name: 'Delivery DLV-20261031-0001' })).toBeTruthy();
    // The Dashboard's pending orders include part-delivered ones.
    const pending = screen.getByRole('option', { name: /Pending Fulfillment/ }) as HTMLOptionElement;
    expect(pending.value.split(',')).toContain('PART_DELIVERED');
  });

  it('cancels the rest, listing what will not be delivered, asking why and how the money goes back', async () => {
    current = PART;
    const user = await openList();
    await user.click(screen.getByRole('button', { name: 'Cancel the rest…' }));
    const dialog = await screen.findByRole('dialog', { name: /Cancel the rest of ORD-20261031-0030/ });
    expect(dialog.textContent).toMatch(/Fikir Eske Mekabir × 1/);
    expect(dialog.textContent).toMatch(/Oromay × 2/);
    expect(dialog.textContent).toMatch(/ETB 40\.00/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the rest' }));
    expect(sent('POST', '/orders/30/cancel-rest')).toEqual([]);
    await user.type(within(dialog).getByLabelText(/Why/), 'Out of print');
    await user.click(within(dialog).getByLabelText('Store credit for the customer'));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the rest' }));
    await settle();
    expect(sent('POST', '/orders/30/cancel-rest')).toEqual([{ reason: 'Out of print', refundTo: 'store_credit' }]);
  });

  it('asks a credit order nothing about money: the value comes off what the customer owes', async () => {
    current = { ...PART, saleType: 'credit_sale', amountPaid: 0, paymentStatus: 'unpaid' };
    const user = await openList();
    await user.click(screen.getByRole('button', { name: 'Cancel the rest…' }));
    const dialog = await screen.findByRole('dialog', { name: /Cancel the rest of/ });
    expect(dialog.textContent).toMatch(/comes off what the customer owes/);
    expect(within(dialog).queryByLabelText('Store credit for the customer')).toBeNull();
    await user.type(within(dialog).getByLabelText(/Why/), 'Changed mind');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the rest' }));
    await settle();
    expect(sent('POST', '/orders/30/cancel-rest')).toEqual([{ reason: 'Changed mind' }]);
  });
});
