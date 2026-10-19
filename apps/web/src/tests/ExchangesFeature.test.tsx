// #23 (M6, step 4): Exchanges move to features/exchanges. The page offers
// only what the API accepts, by any role held in the branch (owner decision
// 1a), checks trade-in values and amounts before sending, asks a void's
// reason in the app's dialog, and leaves the branch to the session. Every
// mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CustomerListResponseSchema, CustomerSchema, ExchangeListResponseSchema,
  ExchangeSchema, LocationListResponseSchema, ProfileResponseSchema,
  type Book, type Customer, type Exchange, type ProfileResponse,
} from '@bms/shared';
import ExchangesPage from '../features/exchanges/pages/ExchangesPage.js';
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

const book = (id: number, title: string, defaultPrice: number | null): Book => contract(BookSchema, {
  id, isbn: `97803064061${String(id).padStart(2, '0')}`, sku: null, title, authors: [], authorIds: [], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
});

const BOOKS = [book(1, 'Fikir Eske Mekabir', 100), book(2, 'Oromay', 150), book(5, 'Some Book', null)];

const customer: Customer = contract(CustomerSchema, {
  id: 77, branchId: 1, customerCode: 'CUS-0077', fullName: 'Jane Trader', phone: null, email: null, gender: null,
  dateOfBirth: null, address: null, city: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
  loyaltyBalance: 0, lifetimePoints: 0, storeCreditBalance: 0, outstandingReceivables: 0, groups: [],
});

const exchange: Exchange = contract(ExchangeSchema, {
  id: '7', exchangeReference: 'EXC-20261018-0001', branchId: 1, locationId: 9, customerId: null, status: 'Completed',
  lifecycleStatus: null, totalIncomingValue: 40, totalOutgoingValue: 150, netBalance: 110, settlementType: 'Customer_Pays',
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
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const items = BOOKS.filter((b) => b.title.toLowerCase().includes(q)).map((b) => ({
        ...b, availability: { locationId: 9, locationName: 'Main Store', onHand: 4, reserved: 0, available: 4 },
      }));
      return json(contract(BookAvailabilityListResponseSchema, { items, total: items.length, page: 1, pageSize: 8, totalPages: 1 }));
    }
    if (u.pathname === '/customers') return json(contract(CustomerListResponseSchema, { items: [customer], total: 1, page: 1, totalPages: 1 }));
    if (method === 'POST' && u.pathname === '/books/quick-register') return json(book(42, 'Trade-In Novel', null), 201);
    if (method === 'POST' && u.pathname === '/exchanges') return json(exchange, 201);
    if (u.pathname === '/exchanges/7') {
      const item = (id: string, bookId: number, bookTitle: string, unitPrice: number) => ({ id, exchangeId: '7', bookId, bookTitle, quantity: 1, unitPrice, totalPrice: unitPrice });
      return json(contract(ExchangeSchema, {
        ...exchange,
        incomingItems: [{ ...item('1', 1, 'Fikir Eske Mekabir', 40), condition: 'resellable' }],
        outgoingItems: [item('2', 2, 'Oromay', 150)],
        settlementEntries: [{ id: '1', entryType: 'cash_payment', amount: 110, method: 'cash', reference: null, payerBank: null, createdAt: CREATED }],
      }));
    }
    if (method === 'POST' && u.pathname === '/exchanges/7/void') return json({ ...exchange, status: 'Cancelled', voidable: false });
    if (u.pathname === '/exchanges') return json(contract(ExchangeListResponseSchema, { items: [exchange], total: 1, page: 1, totalPages: 1 }));
    // Bank Accounts off.
    if (u.pathname.includes('/bank-accounts')) return new Response('{}', { status: 404 });
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body as Record<string, unknown>);

async function openPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><ExchangesPage /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
}

async function openQuickExchange() {
  await openPage();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Quick Exchange/i }));
  await waitFor(() => expect(screen.getByDisplayValue('Main Store (default)')).toBeInTheDocument());
  return user;
}

async function addBook(user: ReturnType<typeof userEvent.setup>, side: 'Incoming' | 'Outgoing', search: string, title: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`Add ${side}`, 'i') }));
  await user.type(screen.getByPlaceholderText(/Search books to add as/i), search);
  await user.click(await screen.findByText(title));
}

async function pickCustomer(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/Search customer by name or code/i), 'Jane');
  await user.click(await screen.findByText('Jane Trader'));
}

async function setAllowance(user: ReturnType<typeof userEvent.setup>, title: string, value: string) {
  const input = screen.getByLabelText(`Allowance for ${title}`);
  await user.clear(input);
  await user.type(input, value);
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('Quick Exchange: settling the difference', () => {
  it('sends the payment taken at the counter, a damaged trade-in, and no outgoing price', async () => {
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Fikir', 'Fikir Eske Mekabir');
    await user.selectOptions(screen.getByLabelText('Condition of Fikir Eske Mekabir'), 'damaged');
    await addBook(user, 'Outgoing', 'Oromay', 'Oromay');
    expect(screen.queryByDisplayValue('150')).not.toBeInTheDocument();
    expect(screen.getByTitle('Catalog price')).toHaveTextContent('150.00');

    await user.selectOptions(screen.getByLabelText('Payment method'), 'mobile');
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    expect(posted('/exchanges')).toHaveLength(0);
    await user.type(screen.getByLabelText('Telebirr transaction number'), 'TB-EX-1');
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));

    await waitFor(() => expect(posted('/exchanges')).toHaveLength(1));
    const body = posted('/exchanges')[0];
    expect(body).toMatchObject({
      locationId: 9,
      incomingItems: [{ bookId: 1, quantity: 1, unitPrice: 100, condition: 'damaged' }],
      outgoingItems: [{ bookId: 2, quantity: 1 }],
      payments: [{ method: 'mobile', amount: 50, reference: 'TB-EX-1' }],
      allowCredit: false,
    });
    expect((body.outgoingItems as object[])[0]).not.toHaveProperty('unitPrice');
  });

  it('asks how the store gives back the difference, store credit by default', async () => {
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Oromay', 'Oromay');
    expect(screen.getByLabelText('Refund method')).toHaveValue('store_credit');
    await user.selectOptions(screen.getByLabelText('Refund method'), 'cash');
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    await waitFor(() => expect(posted('/exchanges')).toHaveLength(1));
    expect(posted('/exchanges')[0]).toMatchObject({ refundMethod: 'cash', payments: [] });
  });

  it('refuses an amount paid in fractions of a cent (was: rounded and sent as another amount)', async () => {
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Fikir', 'Fikir Eske Mekabir');
    await addBook(user, 'Outgoing', 'Oromay', 'Oromay');
    await user.type(screen.getByLabelText('Amount paid'), '49.999');
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    expect(await screen.findByText('Enter an amount more than zero, in whole cents')).toBeInTheDocument();
    expect(posted('/exchanges')).toHaveLength(0);
  });
});

describe('Quick Exchange: trade-in values', () => {
  it('blocks a trade-in with no allowance, and sends it once one is entered', async () => {
    me = profile(['Manager']);
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Some', 'Some Book');
    await user.click(screen.getByRole('button', { name: /Complete Exchange/i }));
    expect(posted('/exchanges')).toHaveLength(0);

    await setAllowance(user, 'Some Book', '15');
    await pickCustomer(user);
    await user.click(screen.getByRole('button', { name: /Complete Exchange/i }));
    await waitFor(() => expect(posted('/exchanges')).toHaveLength(1));
    expect(posted('/exchanges')[0]).toMatchObject({ customerId: 77, incomingItems: [expect.objectContaining({ bookId: 5, unitPrice: 15 })] });
  });

  it('refuses an allowance in fractions of a cent (was: sent, refused by the API)', async () => {
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Fikir', 'Fikir Eske Mekabir');
    await setAllowance(user, 'Fikir Eske Mekabir', '40.005');
    await pickCustomer(user);
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    expect(await screen.findByText(/Enter a trade-in allowance for "Fikir Eske Mekabir": more than zero, in whole cents/)).toBeInTheDocument();
    expect(posted('/exchanges')).toHaveLength(0);
  });

  it('holds an allowance to the selling price (was: sent, refused by the API)', async () => {
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Fikir', 'Fikir Eske Mekabir');
    await setAllowance(user, 'Fikir Eske Mekabir', '120');
    await pickCustomer(user);
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    expect(await screen.findByText(/can be valued at most at its selling price, 100\.00/)).toBeInTheDocument();
    expect(posted('/exchanges')).toHaveLength(0);
  });

  it('does not let Sales value a book with no price (was: sent, refused by the API)', async () => {
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Some', 'Some Book');
    await setAllowance(user, 'Some Book', '15');
    await pickCustomer(user);
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    expect(await screen.findByText(/"Some Book" has no price yet; a Manager or Admin values it/)).toBeInTheDocument();
    expect(posted('/exchanges')).toHaveLength(0);
  });

  it('lets a Manager by any role held value a book with no price', async () => {
    me = profile(['Sales', 'Manager']);
    const user = await openQuickExchange();
    await addBook(user, 'Incoming', 'Some', 'Some Book');
    await setAllowance(user, 'Some Book', '15');
    await pickCustomer(user);
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    await waitFor(() => expect(posted('/exchanges')).toHaveLength(1));
  });
});

describe('Quick Exchange: what it asks the API', () => {
  it('leaves the branch to the session and offers active customers only (was: the branch sent from the client, any customer)', async () => {
    const user = await openQuickExchange();
    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Fikir');
    expect(await screen.findByText(/4 available/)).toBeInTheDocument();
    const search = calls.find((c) => c.path.startsWith('/books/with-availability'));
    expect(search?.path).toContain('locationId=9');
    expect(search?.path).not.toContain('branchId');

    await user.type(screen.getByPlaceholderText(/Search customer by name or code/i), 'Jane');
    await screen.findByText('Jane Trader');
    expect(calls.find((c) => c.path.startsWith('/customers?'))?.path).toContain('status=active');
    expect(calls.find((c) => c.path.startsWith('/exchanges?'))?.path).not.toContain('branchId');
  });

  it('offers to register a book brought in that the shop never had, and adds it to the incoming list', async () => {
    me = profile(['Manager']);
    const user = await openQuickExchange();
    await user.click(screen.getByRole('button', { name: /Add Outgoing/i }));
    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Trade-In Novel');
    await settle();
    expect(screen.queryByText(/Quick-register/)).not.toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText(/Search books to add as/i));

    await user.click(screen.getByRole('button', { name: /Add Incoming/i }));
    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Trade-In Novel');
    await user.click(await screen.findByText(/Quick-register "Trade-In Novel" as a new catalog entry/));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByDisplayValue('Trade-In Novel');
    await user.clear(title);
    expect(within(dialog).getByRole('button', { name: /Register & Add/i })).toBeDisabled();
    await user.type(title, 'Trade-In Novel');
    await user.click(within(dialog).getByRole('button', { name: /Register & Add/i }));

    await waitFor(() => expect(posted('/books/quick-register')).toEqual([expect.objectContaining({ title: 'Trade-In Novel' })]));
    expect(await screen.findByText('Trade-In Novel')).toBeInTheDocument();
  });
});

describe('Exchanges: printing', () => {
  it('prints an exchange slip, not the whole screen (owner decision 1a)', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    await openPage();
    const user = userEvent.setup();
    const row = (await screen.findByText('EXC-20261018-0001')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Print/ }));
    expect(print).not.toHaveBeenCalled();

    const slip = screen.getByRole('dialog', { name: 'Exchange EXC-20261018-0001' });
    expect(slip).toHaveAttribute('id', 'print-slip');
    expect(await within(slip).findByText(/Fikir Eske Mekabir × 1/)).toBeInTheDocument();
    expect(within(slip).getByText(/Oromay × 1/)).toBeInTheDocument();
    await user.click(within(slip).getByRole('button', { name: /Print/ }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});

describe('Exchanges: voiding', () => {
  it('is offered to a Manager by any role held in the branch (was: only by the main role)', async () => {
    me = profile(['Sales', 'Manager']);
    await openPage();
    const row = (await screen.findByText('EXC-20261018-0001')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Void' })).toBeInTheDocument();
  });

  it('is not offered to Sales', async () => {
    await openPage();
    const row = (await screen.findByText('EXC-20261018-0001')).closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it("asks the reason in the app's dialog, then sends it (was: the browser's prompt box)", async () => {
    me = profile(['Manager']);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Wrong books');
    await openPage();
    const user = userEvent.setup();
    const row = (await screen.findByText('EXC-20261018-0001')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    expect(promptSpy).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Void Exchange' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), 'Wrong books');
    await user.click(within(dialog).getByRole('button', { name: 'Void Exchange' }));
    await waitFor(() => expect(posted('/exchanges/7/void')).toEqual([{ reason: 'Wrong books' }]));
    promptSpy.mockRestore();
  });
});
