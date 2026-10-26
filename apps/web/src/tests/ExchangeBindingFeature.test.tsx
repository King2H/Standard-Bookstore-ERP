// #169 PR 4 (owner decisions 1a–5a): binding on the books an exchange gives
// out. An outgoing line takes a binding for some or all of its copies, at the
// branch's fee with no discount (2a), for a named customer; its fee is part of
// what goes out, so it moves the difference (3a). The exchange's detail shows
// the job, which whoever sells moves on; the board names the exchange as its
// source (1a), and a fee given back names the exchange in Returns (5a).
// Before, an exchange gave out books only. Every mocked answer is checked
// against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CustomerListResponseSchema, CustomerSchema, ExchangeListResponseSchema, ExchangeSchema,
  LocationListResponseSchema, ProfileResponseSchema, ReturnListResponseSchema, ReturnSchema, ServiceJobListResponseSchema, ServiceJobSchema,
  ServiceListResponseSchema, ServiceSchema,
  type Book, type Exchange, type ProfileResponse, type SaleServiceLine, type Service, type ServiceJobStatus,
} from '@bms/shared';
import ExchangesPage from '../features/exchanges/pages/ExchangesPage.js';
import BindingJobsPage from '../features/services/pages/BindingJobsPage.js';
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

const oromay: Book = contract(BookSchema, {
  id: 2, isbn: '9780306406102', sku: null, title: 'Oromay', authors: [], authorIds: [], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice: 150,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
});

// A discountable fee: an exchange still gives no discount on it (2a).
const cloth: Service = contract(ServiceSchema, {
  id: 2, code: 'BIND-CLOTH', name: 'Cloth binding', kind: 'binding', formatId: 3, formatLabel: 'Cloth Bound', fee: 100,
  branchFee: null, effectiveFee: 100, standardCost: 40, discountable: true, turnaroundDays: 3, status: 'ACTIVE',
  createdAt: CREATED, updatedAt: CREATED,
});

const job = (status: ServiceJobStatus) => contract(ServiceJobSchema, {
  id: 41, jobNumber: 'SVC-20261026-0007', status, readyDate: '2026-10-29', customerId: 77, branchId: 1, updatedAt: CREATED,
});
const bound = (status: ServiceJobStatus): SaleServiceLine => ({
  id: 6, serviceId: 2, serviceCode: 'BIND-CLOTH', serviceName: 'Cloth binding', quantity: 1, unitFee: 100, discountAmount: 0,
  lineTotal: 100, standardCost: 40, job: job(status),
});

const exchange: Exchange = contract(ExchangeSchema, {
  id: '7', exchangeReference: 'EXC-20261026-0001', branchId: 1, locationId: 9, customerId: 77, status: 'Completed',
  lifecycleStatus: null, totalIncomingValue: 0, totalOutgoingValue: 250, netBalance: 250, settlementType: 'Customer_Pays',
  refundMethod: null, currency: 'ETB', notes: null, createdBy: 9, createdAt: CREATED, updatedAt: CREATED, outstandingAmount: 0,
  dueDate: null, settlementStatus: 'Settled', voidable: true, voidedAt: null, voidedBy: null, voidReason: null,
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
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, {
        items: [{ id: 9, branchId: 1, name: 'Main Store', isDefaultFulfillment: true, createdAt: CREATED }], total: 1, accessMode: 'full',
      }));
    }
    if (u.pathname === '/books/with-availability') {
      return json(contract(BookAvailabilityListResponseSchema, {
        items: [{ ...oromay, availability: { locationId: 9, locationName: 'Main Store', onHand: 4, reserved: 0, available: 4 } }],
        total: 1, page: 1, pageSize: 8, totalPages: 1,
      }));
    }
    if (u.pathname === '/services') return json(contract(ServiceListResponseSchema, { items: [cloth], total: 1, page: 1, pageSize: 100, totalPages: 1 }));
    if (u.pathname === '/customers') {
      return json(contract(CustomerListResponseSchema, {
        items: [contract(CustomerSchema, {
          id: 77, branchId: 1, customerCode: 'CUS-0077', fullName: 'Jane Trader', phone: null, email: null, gender: null,
          dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
          loyaltyBalance: 0, lifetimePoints: 0, storeCreditBalance: 0, outstandingReceivables: 0, groups: [],
        })],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (method === 'POST' && u.pathname === '/exchanges') return json(exchange, 201);
    if (u.pathname === '/exchanges/7') {
      return json(contract(ExchangeSchema, {
        ...exchange,
        incomingItems: [],
        outgoingItems: [{ id: '2', exchangeId: '7', bookId: 2, bookTitle: 'Oromay', quantity: 2, unitPrice: 150, totalPrice: 300, service: bound('REQUESTED') }],
        settlementEntries: [],
      }));
    }
    if (u.pathname === '/exchanges') return json(contract(ExchangeListResponseSchema, { items: [exchange], total: 1, page: 1, totalPages: 1 }));
    const step = u.pathname.match(/^\/service-jobs\/(\d+)\/(send|ready|collect)$/);
    if (method === 'POST' && step) return json(job('AT_BINDER'));
    if (u.pathname === '/service-jobs') {
      return json(contract(ServiceJobListResponseSchema, {
        items: [{
          ...job('REQUESTED'), serviceName: 'Cloth binding', quantity: 1, bookTitle: 'Oromay', customerName: 'Jane Trader', customerPhone: null,
          source: 'EXCHANGE', saleId: '7', saleNumber: 'EXC-20261026-0001', overdue: false,
        }],
        total: 1, page: 1, pageSize: 25, totalPages: 1,
      }));
    }
    if (u.pathname === '/returns') {
      return json(contract(ReturnListResponseSchema, {
        items: [contract(ReturnSchema, {
          id: '9', returnNumber: 'RET-20261026-0002', transactionId: null, transactionNumber: null, orderId: null, orderNumber: null,
          exchangeId: '7', exchangeReference: 'EXC-20261026-0001', branchId: 1, customerId: 77, totalRefundAmount: 100,
          refundMethod: 'store_credit', status: 'completed', reason: 'Customer changed their mind', processedBy: 9, approvedBy: 9, createdAt: CREATED,
        })],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (u.pathname.includes('/bank-accounts')) return new Response('{}', { status: 404 });
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body as Record<string, unknown>);

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('binding on an outgoing book (2a, 3a)', () => {
  async function exchangeWithOromay() {
    const user = renderWith(<ExchangesPage />);
    await settle();
    await user.click(screen.getByRole('button', { name: /Quick Exchange/i }));
    await waitFor(() => expect(screen.getByDisplayValue('Main Store (default)')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Add Outgoing/i }));
    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Orom');
    await user.click(await screen.findByText('Oromay'));
    // Picked again, the line takes a second copy.
    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Orom');
    await user.click(await screen.findByText('Oromay', { selector: 'p' }));
    expect(screen.getByLabelText('Quantity of Oromay taken')).toHaveValue(2);
    return user;
  }

  it('adds the fee to what goes out, with no discount, and sends the binding with its line (was: books only)', async () => {
    const user = await exchangeWithOromay();
    await user.click(screen.getByRole('button', { name: '+ Binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Binding: Oromay' });
    await user.selectOptions(within(dialog).getByLabelText('Binding'), 'Cloth binding — ETB 100.00, ready in 3 days');
    expect(within(dialog).queryByLabelText('Discount (%)')).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Copies (of 2)'));
    await user.type(within(dialog).getByLabelText('Copies (of 2)'), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Cloth binding × 1/)).toBeInTheDocument();
    // Two books at 150 and one binding at 100.
    expect(screen.getByText('Net Balance').nextElementSibling?.textContent).toBe('ETB 400.00');

    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    expect(await screen.findByText('A binding needs a customer, who is called when it is ready')).toBeInTheDocument();
    expect(posted('/exchanges')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText(/Search customer by name or code/i), 'Jane');
    await user.click(await screen.findByText('Jane Trader'));
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    await waitFor(() => expect(posted('/exchanges')).toHaveLength(1));
    expect(posted('/exchanges')[0]).toMatchObject({
      customerId: 77,
      outgoingItems: [{ bookId: 2, quantity: 2, service: { serviceId: 2, quantity: 1 } }],
      payments: [{ method: 'cash', amount: 400 }],
    });
    expect((posted('/exchanges')[0].outgoingItems as Array<{ service: object }>)[0].service).toEqual({ serviceId: 2, quantity: 1 });
  });

  it('keeps the binding to the line\'s copies when fewer are taken', async () => {
    const user = await exchangeWithOromay();
    await user.click(screen.getByRole('button', { name: '+ Binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Binding: Oromay' });
    await user.selectOptions(within(dialog).getByLabelText('Binding'), 'Cloth binding — ETB 100.00, ready in 3 days');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Cloth binding × 2/)).toBeInTheDocument();
    // Down to one copy: the field reads "1" once cleared.
    await user.clear(screen.getByLabelText('Quantity of Oromay taken'));
    expect(screen.getByText(/Cloth binding × 1/)).toBeInTheDocument();
    expect(screen.getByText('Net Balance').nextElementSibling?.textContent).toBe('ETB 250.00');
  });
});

describe('after the exchange (1a, 5a)', () => {
  it('shows the binding\'s job on the exchange, and whoever sells moves it on', async () => {
    const user = renderWith(<ExchangesPage />);
    await user.click(await screen.findByText('EXC-20261026-0001'));
    expect(await screen.findByText('SVC-20261026-0007')).toBeInTheDocument();
    expect(screen.getByText(/Cloth binding × 1/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sent to binder' }));
    await waitFor(() => expect(posted('/service-jobs/41/send')).toHaveLength(1));
  });

  it('names the exchange as the job\'s source on the board', async () => {
    renderWith(<BindingJobsPage />);
    const row = (await screen.findByText('SVC-20261026-0007')).closest('tr') as HTMLElement;
    expect(within(row).getByText('EXC-20261026-0001')).toBeInTheDocument();
    expect(within(row).getByText('Exchange')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Sent to binder' })).toBeInTheDocument();
  });

  it('names the exchange of a binding fee given back in Returns', async () => {
    const user = renderWith(<ReturnsPage initialContext={{}} />);
    await user.click(await screen.findByRole('button', { name: /Returns History/ }));
    const row = (await screen.findByText('RET-20261026-0002')).closest('tr') as HTMLElement;
    expect(within(row).getByText('EXC-20261026-0001')).toBeInTheDocument();
  });
});
