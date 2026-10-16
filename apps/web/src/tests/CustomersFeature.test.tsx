// #23 (M6, step 4): Customers move to features/customers. The page offers
// only what the API accepts (any role held counts; receivables for the roles
// that take payments), pages through every history, keeps the list and the
// profile current after a change, lets a deactivation be undone (owner
// decision 1a), records manual adjustments without a client-chosen type (2a),
// and waits for typing to pause before searching. Every mocked answer is
// checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CustomerListResponseSchema, CustomerSchema, CurrencyResponseSchema, LoyaltyHistoryResponseSchema, MessageResponseSchema,
  ProfileResponseSchema, ReceivableListResponseSchema, StoreCreditHistoryResponseSchema, type Customer, type ProfileResponse,
} from '@bms/shared';
import CustomersPage from '../features/customers/pages/CustomersPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const customer = (over: Partial<Customer> = {}): Customer => contract(CustomerSchema, {
  id: 1, branchId: 1, customerCode: 'CUS-0001', fullName: 'Abebe Kebede', phone: '0911000000', email: null, gender: null,
  dateOfBirth: null, address: null, city: 'Addis Ababa', isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
  loyaltyBalance: 120, lifetimePoints: 300, storeCreditBalance: 10, outstandingReceivables: 0, groups: [], ...over,
});

const receivable = (id: number, status: 'Pending' | 'Settled') => ({
  id: String(id), sourceType: 'pos_credit_sale' as const, sourceRefId: `TXN-${id}`, sourceEntityId: String(id), customerId: 1,
  customerName: 'Abebe Kebede', customerCode: 'CUS-0001', branchId: 1, originalAmount: 50, outstandingAmount: status === 'Settled' ? 0 : 50,
  currency: 'ETB', dueDate: null, settlementDate: null, status, notes: null, writtenOffAmount: null, writtenOffAt: null,
  writtenOffBy: null, writeOffReason: null, cancelledAmount: null, cancelledAt: null, createdAt: CREATED, updatedAt: CREATED,
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let current: Customer;
let loyaltyEntries: number;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    const page = Number(u.searchParams.get('page') ?? 1);
    const pageSize = Number(u.searchParams.get('pageSize') ?? 25);
    const paged = <T,>(all: T[]) => ({ items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, totalPages: Math.ceil(all.length / pageSize) });

    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: 'ETB' }));
    if (u.pathname === '/customers') return json(contract(CustomerListResponseSchema, paged([current])));
    if (u.pathname === '/customers/1' && method === 'GET') return json(contract(CustomerSchema, current));
    if (u.pathname === '/customers/1' && method === 'PUT') {
      current = customer({ ...current, ...body });
      return json(contract(CustomerSchema, current));
    }
    if (u.pathname === '/customers/1/loyalty/history') {
      const all = Array.from({ length: loyaltyEntries }, (_, i) => ({
        id: String(i + 1), customerId: 1, transactionRef: null, pointsDelta: 10, reason: `ACCRUAL ${i + 1}`, createdAt: CREATED,
      }));
      return json(contract(LoyaltyHistoryResponseSchema, paged(all)));
    }
    if (u.pathname === '/customers/1/store-credit/history') return json(contract(StoreCreditHistoryResponseSchema, paged([])));
    if (u.pathname === '/receivables') {
      if (!me.currentRoles.some((r) => ['Admin', 'Manager', 'Finance_Officer', 'Sales'].includes(r))) {
        return json({ error: 'FORBIDDEN', message: 'Not permitted' }, 403);
      }
      return json(contract(ReceivableListResponseSchema, paged([receivable(1, 'Pending'), receivable(2, 'Settled')])));
    }
    const action = u.pathname.match(/^\/customers\/1\/(deactivate|activate|archive|restore)$/);
    if (method === 'POST' && action) {
      const status = action[1] === 'deactivate' ? 'INACTIVE' : action[1] === 'archive' ? 'ARCHIVED' : 'ACTIVE';
      current = customer({ ...current, status, isActive: status === 'ACTIVE' });
      return json(contract(MessageResponseSchema, { message: 'Done' }));
    }
    if (method === 'POST' && u.pathname === '/customers/1/store-credit/adjust') {
      current = customer({ ...current, storeCreditBalance: current.storeCreditBalance + Number(body.amount) });
      return json(contract(MessageResponseSchema, { message: 'Done' }));
    }
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><CustomersPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Abebe Kebede');
  await settle();
}

async function openProfile(tab?: string) {
  const user = userEvent.setup();
  await renderList();
  await user.click(within(screen.getByText('Abebe Kebede').closest('tr')!).getByRole('button', { name: 'View' }));
  await screen.findByText('← Back to List');
  await settle();
  if (tab) {
    await user.click(screen.getByRole('button', { name: tab }));
    await settle();
  }
}

/** The control under a label, whether the label names it or only sits above it. */
const field = (label: string) => screen.getByText(label, { selector: 'label' }).parentElement!.querySelector('input, select') as HTMLElement;
const customerRequests = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/customers?'));

beforeEach(() => {
  setAccessToken('x');
  me = profile(['Admin']);
  current = customer();
  loyaltyEntries = 3;
  stubApi();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Customers: who may do what', () => {
  it('offers balance corrections to a Sales clerk also made Finance_Officer (was: only the first role counted)', async () => {
    me = profile(['Sales', 'Finance_Officer']);
    await openProfile('Loyalty');
    expect(screen.getByText('Redeem Points')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Store Credit' }));
    expect(await screen.findByText('Manual Adjustment')).toBeInTheDocument();
  });

  it('does not offer receivables to a Stock Clerk, whom the API refuses (was: "No outstanding receivables yet")', async () => {
    me = profile(['Stock_Clerk']);
    await openProfile();
    expect(screen.queryByRole('button', { name: 'Receivables' })).not.toBeInTheDocument();
  });
});

describe('Customers: histories', () => {
  it('pages through loyalty history beyond the newest 25 (was: the newest 25 only)', async () => {
    loyaltyEntries = 30;
    await openProfile('Loyalty');
    expect(await screen.findByText('ACCRUAL 25')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /next page/i }));
    expect(await screen.findByText('ACCRUAL 30')).toBeInTheDocument();
  });

  it('calls the receivables tab what it lists, settled ones included (was: "Outstanding Receivables")', async () => {
    await openProfile('Receivables');
    expect(await screen.findByRole('heading', { name: 'Receivables' })).toBeInTheDocument();
    expect(screen.getByText('Settled')).toBeInTheDocument();
  });
});

describe('Customers: changes', () => {
  it('shows the new balance in the list after a store-credit adjustment (was: the list kept the old balance)', async () => {
    const user = userEvent.setup();
    await openProfile('Store Credit');
    await user.type(field('Amount'), '30');
    await user.type(screen.getByPlaceholderText('Why is the balance changed?'), 'Goodwill');
    await user.click(screen.getByRole('button', { name: 'Apply Adjustment' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/customers/1/store-credit/adjust')).toBe(true));
    await settle();
    await user.click(screen.getByText('← Back to List'));
    const row = (await screen.findByText('Abebe Kebede')).closest('tr')!;
    await waitFor(() => expect(within(row).getByText('ETB 40.00')).toBeInTheDocument());
  });

  it('records a manual adjustment without a client-chosen type (owner decision 2a; was: a free "Ref Type")', async () => {
    const user = userEvent.setup();
    await openProfile('Store Credit');
    await user.type(field('Amount'), '5');
    await user.type(screen.getByPlaceholderText('Why is the balance changed?'), 'Goodwill');
    await user.click(screen.getByRole('button', { name: 'Apply Adjustment' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/customers/1/store-credit/adjust')?.body).toBeDefined());
    expect(calls.find((c) => c.path === '/customers/1/store-credit/adjust')!.body).not.toHaveProperty('refType');
  });

  it('shows Inactive at once after deactivating from the profile (was: still Active)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openProfile();
    const header = screen.getByText('← Back to List').parentElement!;
    await userEvent.setup().click(within(header).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(within(header).getByText('Inactive')).toBeInTheDocument());
  });

  it('activates a deactivated customer again (owner decision 1a; was: no way back)', async () => {
    current = customer({ status: 'INACTIVE', isActive: false });
    await renderList();
    const row = screen.getByText('Abebe Kebede').closest('tr')!;
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/customers/1/activate')).toBe(true));
  });

  it('clears an emptied phone and city when saving the profile', async () => {
    const user = userEvent.setup();
    await openProfile();
    await user.clear(field('Phone'));
    await user.clear(field('City'));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ fullName: 'Abebe Kebede', phone: null, city: null }));
  });
});

describe('Customers: search', () => {
  it('asks once typing pauses (was: a request for every key)', async () => {
    await renderList();
    await userEvent.setup().type(screen.getByPlaceholderText('Search by name, phone, code...'), 'Abebe');
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(customerRequests().filter((c) => new URL(c.path, 'http://x').searchParams.has('q')).map((c) => new URL(c.path, 'http://x').searchParams.get('q')))
      .toEqual(['Abebe']);
  });
});
