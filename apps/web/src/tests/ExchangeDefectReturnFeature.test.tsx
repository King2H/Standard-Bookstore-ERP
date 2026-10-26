// #203 (owner decisions 1a, 2a): Returns takes an exchange by its EXC-
// number. Only its defective bound copies come back, taken by a Manager or
// Admin with a reason, with their share of the fee; the value goes against
// what the exchange left on credit, the rest to store credit. A plain copy is
// swapped in a new exchange. Before, Returns found no exchange. Every mocked
// answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ExchangeListResponseSchema, ExchangeSchema, ProfileResponseSchema, ReturnSchema, ServiceJobSchema,
  type Exchange, type ProfileResponse, type SaleServiceLine, type ServiceJobStatus,
} from '@bms/shared';
import ReturnsPage from '../features/returns/pages/ReturnsPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-26T07:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const bound = (status: ServiceJobStatus): SaleServiceLine => ({
  id: 6, serviceId: 2, serviceCode: 'BIND-CLOTH', serviceName: 'Cloth binding', quantity: 2, unitFee: 100, discountAmount: 0,
  lineTotal: 200, standardCost: 40, job: contract(ServiceJobSchema, {
    id: 41, jobNumber: 'SVC-20261026-0007', status, readyDate: '2026-10-29', customerId: 77, branchId: 1, updatedAt: CREATED,
  }),
});

const exchange = (status: ServiceJobStatus | null): Exchange => contract(ExchangeSchema, {
  id: '7', exchangeReference: 'EXC-20261026-0001', branchId: 1, locationId: 9, customerId: 77, status: 'Completed',
  lifecycleStatus: null, totalIncomingValue: 0, totalOutgoingValue: 650, netBalance: 650, settlementType: 'Customer_Pays',
  refundMethod: null, currency: 'ETB', notes: null, createdBy: 9, createdAt: CREATED, updatedAt: CREATED, outstandingAmount: 0,
  dueDate: null, settlementStatus: 'Settled', voidable: false, voidedAt: null, voidedBy: null, voidReason: null,
  incomingItems: [],
  outgoingItems: [
    { id: '2', exchangeId: '7', bookId: 2, bookTitle: 'Oromay', quantity: 3, unitPrice: 150, totalPrice: 450, service: status ? bound(status) : null },
    { id: '3', exchangeId: '7', bookId: 4, bookTitle: 'Fikir Eske Mekabir', quantity: 1, unitPrice: 200, totalPrice: 200, service: null },
  ],
  settlementEntries: [],
});

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let theExchange: Exchange;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/exchanges') {
      const found = u.searchParams.get('exchangeReference') === theExchange.exchangeReference
        ? [{ ...theExchange, incomingItems: undefined, outgoingItems: undefined, settlementEntries: undefined }] : [];
      return json(contract(ExchangeListResponseSchema, { items: found, total: found.length, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/exchanges/7') return json(theExchange);
    if (method === 'POST' && u.pathname === '/returns') {
      return json(contract(ReturnSchema, {
        id: '9', returnNumber: 'RET-20261026-0003', transactionId: null, transactionNumber: null, orderId: null, orderNumber: null,
        exchangeId: '7', exchangeReference: 'EXC-20261026-0001', branchId: 1, customerId: 77, totalRefundAmount: 250,
        refundMethod: 'store_credit', status: 'completed', reason: 'Spine cracked', processedBy: 9, approvedBy: 9, createdAt: CREATED,
      }), 201);
    }
    return json({ items: [], total: 0, page: 1, totalPages: 0 });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body as Record<string, unknown>);

async function pickExchange() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><ReturnsPage initialContext={{}} /></ToastProvider></QueryClientProvider>);
  await settle();
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Transaction or order number' }), 'EXC-20261026-0001');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.click(await screen.findByRole('button', { name: /Use this exchange/ }));
  await settle();
  return user;
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Manager']);
  theExchange = exchange('COLLECTED');
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('a defective bound copy from an exchange (#203)', () => {
  it('is found by its EXC- number and comes back defective, by a Manager, with a reason (was: no exchange found)', async () => {
    const user = await pickExchange();
    expect(screen.getByText(/2 bound \(Collected\): they come back only defective/)).toBeInTheDocument();
    // Only bound copies: the book with no binding is swapped in a new exchange.
    expect(screen.queryByText('Fikir Eske Mekabir')).not.toBeInTheDocument();
    const qty = screen.getByRole('spinbutton', { name: 'Quantity of Oromay to return' });
    expect(qty).toHaveAttribute('max', '0');
    await user.click(screen.getByLabelText('Defective binding'));
    expect(qty).toHaveAttribute('max', '2');
    await user.clear(qty);
    await user.type(qty, '1');
    // The book's 150 and its share of the fee, 100.
    expect(screen.getByText('Total Value').nextElementSibling?.textContent).toMatch(/250\.00$/);
    expect(screen.getByText(/to the customer's store credit/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('What is wrong with the bound copy (required)'), 'Spine cracked');
    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(posted('/returns')).toHaveLength(1));
    expect(posted('/returns')[0]).toEqual({
      exchangeId: 7, reason: 'Spine cracked',
      lines: [{ exchangeLineItemId: 2, quantity: 1, disposition: 'DAMAGED', defective: true }],
    });
  });

  it('offers Sales nothing to take back, and says who does', async () => {
    me = profile(['Sales']);
    await pickExchange();
    expect(screen.queryByLabelText('Defective binding')).not.toBeInTheDocument();
    expect(screen.getByText(/A Manager or Admin takes back a defective bound copy/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Quantity of Oromay to return' })).toHaveAttribute('max', '0');
  });

  it('says so when the exchange has no bound copy to take back', async () => {
    theExchange = exchange(null);
    await pickExchange();
    expect(screen.getByText('This exchange has no bound copy to take back; books from an exchange are swapped in a new exchange.')).toBeInTheDocument();
  });
});
