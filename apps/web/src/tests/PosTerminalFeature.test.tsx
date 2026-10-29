// #23 (M6, step 4): POS part 2. The terminal moves to features/pos. Books
// out of stock can be sold where the branch allows negative stock; amounts,
// tenders and discounts are checked before the sale is sent; only active
// customers are offered; cash handed over for more than is due gives change
// (owner decision 1a); only the receipt is printed (2a); the receipt's due
// date is the day itself; the branch is the session's. Every mocked answer is
// checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, CurrencyResponseSchema, CustomerListResponseSchema, CustomerSchema, EffectiveConfigResponseSchema,
  CurrentCashSessionResponseSchema, LocationListResponseSchema, PosTransactionSchema, ProfileResponseSchema,
  type Book, type Customer, type PosTransaction, type ProfileResponse,
} from '@bms/shared';
import PosPage from '../features/pos/pages/PosPage.js';
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

const book = (id: number, title: string): Book => contract(BookSchema, {
  id, isbn: `97803064061${String(id).padStart(2, '0')}`, sku: null, title, authors: [], authorIds: [], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice: 10,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
});

const customer = (over: Partial<Customer> = {}): Customer => contract(CustomerSchema, {
  id: 1, branchId: 1, customerCode: 'CUS-0001', fullName: 'Abebe Kebede', phone: '0911000000', email: null, gender: null,
  dateOfBirth: null, address: null, city: 'Addis Ababa', isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
  loyaltyBalance: 120, lifetimePoints: 300, storeCreditBalance: 5, outstandingReceivables: 0, groups: [], ...over,
});

function sale(over: Partial<PosTransaction> = {}): PosTransaction {
  return contract(PosTransactionSchema, {
    id: '77', branchId: 1, locationId: 7, customerId: null, staffId: 9, transactionNumber: 'POS-20261018-0001',
    subtotal: 10, discountTotal: 0, taxTotal: 0, grandTotal: 10, amountPaid: 10, amountDue: 0, paymentStatus: 'paid',
    currency: 'ETB', status: 'completed', createdAt: CREATED, dueDate: null, voidable: true, lineItems: [],
    payments: [{ id: '1', transactionId: '77', method: 'cash', amount: 10, reference: null, payerBank: null, bankAccountId: null, createdAt: CREATED }],
    ...over,
  });
}

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let allowNegative: boolean;
let saleAnswer: PosTransaction;
let shopCurrency: string;
let cashRequired: boolean;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: shopCurrency }));
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, {
        items: [{ id: 7, branchId: 1, name: 'Main Floor', isDefaultFulfillment: true, createdAt: CREATED }], total: 1, accessMode: 'full',
      }));
    }
    if (u.pathname === '/config/effective') {
      const values: Record<string, unknown> = { allow_negative_stock: allowNegative, max_line_discount_pct: { Sales: 10, Manager: 25 } };
      const keys = (u.searchParams.get('keys') ?? '').split(',').filter((k) => k in values);
      return json(contract(EffectiveConfigResponseSchema, { items: keys.map((key) => ({ key, value: values[key], source: 'system' as const })) }));
    }
    if (u.pathname === '/books/with-availability') {
      return json(contract(BookAvailabilityListResponseSchema, {
        items: [
          { ...book(1, 'Fikir Eske Mekabir'), availability: { locationId: 7, locationName: 'Main Floor', onHand: 0, reserved: 0, available: 0 } },
          { ...book(2, 'Oromay'), availability: { locationId: 7, locationName: 'Main Floor', onHand: 5, reserved: 0, available: 5 } },
        ],
        total: 2, page: 1, pageSize: 10, totalPages: 1,
      }));
    }
    if (u.pathname === '/customers') {
      return json(contract(CustomerListResponseSchema, { items: [customer()], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/cash-sessions/current') return json(contract(CurrentCashSessionResponseSchema, { required: cashRequired, session: null }));
    if (method === 'POST' && u.pathname === '/pos/transactions' && cashRequired) {
      return new Response(JSON.stringify({ error: 'CASH_SESSION_REQUIRED', message: 'This branch takes cash only with an open cash session; open one first' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'POST' && u.pathname === '/pos/transactions') return json(contract(PosTransactionSchema, saleAnswer));
    // Bank Accounts off.
    if (u.pathname.includes('/bank-accounts')) return new Response('{}', { status: 404 });
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = () => calls.filter((c) => c.method === 'POST' && c.path === '/pos/transactions').map((c) => c.body as Record<string, unknown>);

async function openTerminal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><PosPage userRole={me.currentRoles[0]} userPermissions={['CREATE_SALE']} /></ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByDisplayValue(/Main Floor/);
  await settle();
  return userEvent.setup();
}

async function addBook(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.type(screen.getByPlaceholderText('Title, ISBN, Author…'), title.slice(0, 4));
  await user.click(await screen.findByText(title));
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  allowNegative = false;
  saleAnswer = sale();
  shopCurrency = 'ETB';
  cashRequired = false;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('POS terminal: the cart', () => {
  it('sells a book out of stock where the branch allows negative stock (was: never)', async () => {
    allowNegative = true;
    const user = await openTerminal();
    await user.type(screen.getByPlaceholderText('Title, ISBN, Author…'), 'Fiki');
    const button = (await screen.findByText('Fikir Eske Mekabir')).closest('button')!;
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('still refuses a book out of stock where the branch does not', async () => {
    const user = await openTerminal();
    await user.type(screen.getByPlaceholderText('Title, ISBN, Author…'), 'Fiki');
    expect((await screen.findByText('Fikir Eske Mekabir')).closest('button')).toBeDisabled();
  });

  it("stops a discount above the cashier's limit before sending (was: refused by the API at the end)", async () => {
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    const row = screen.getByText('Oromay').closest('tr')!;
    const discount = within(row).getByRole('spinbutton');
    await user.clear(discount);
    await user.type(discount, '20');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));
    expect(await screen.findByText('The discount on "Oromay" is more than your limit of 10%')).toBeInTheDocument();
    expect(posted()).toEqual([]);
  });

  it("offers an amount discount in the shop's currency (#181; was: always ETB)", async () => {
    shopCurrency = 'USD';
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    const row = screen.getByText('Oromay').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: '%' }));
    expect(within(row).getByRole('button', { name: 'USD' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'ETB' })).not.toBeInTheDocument();
  });

  it('allows the discount of any role held in the branch', async () => {
    me = profile(['Sales', 'Manager']);
    saleAnswer = sale({ grandTotal: 8, subtotal: 8, discountTotal: 2, amountPaid: 8 });
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    const discount = within(screen.getByText('Oromay').closest('tr')!).getByRole('spinbutton');
    await user.clear(discount);
    await user.type(discount, '20');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));
    await waitFor(() => expect(posted()).toHaveLength(1));
  });
});

describe('POS terminal: cash sessions (#171, 1a, 5a)', () => {
  it('has a Cash tab, and says when the branch takes cash only with an open session (was: no session at all)', async () => {
    cashRequired = true;
    const user = await openTerminal();
    expect(await screen.findByText('No cash session')).toBeInTheDocument();
    expect(screen.getByText(/takes cash only with an open cash session/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cash Drawer/ }));
    expect(await screen.findByLabelText('Opening float')).toBeInTheDocument();
  });

  it('offers to open a session when a cash sale is refused for the lack of one', async () => {
    cashRequired = true;
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));
    await user.click(await screen.findByRole('button', { name: 'Open cash session' }));
    expect(await screen.findByLabelText('Opening float')).toBeInTheDocument();
  });
});

describe('POS terminal: customers', () => {
  it('offers only active customers (was: archived ones too, refused by the API)', async () => {
    const user = await openTerminal();
    await user.type(screen.getByPlaceholderText('Search customer… (F9)'), 'Abe');
    await screen.findByText('Abebe Kebede');
    const search = calls.find((c) => c.path.startsWith('/customers?'));
    expect(search?.path).toContain('status=active');
  });
});

describe('POS terminal: payments', () => {
  it('refuses an amount that is not whole cents (was: sent as typed)', async () => {
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    await user.type(screen.getByPlaceholderText('10.00'), '10.005');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter an amount more than zero, in whole cents')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove payment')).not.toBeInTheDocument();
  });

  it('refuses store credit with no customer, and more than the customer holds (was: refused by the API at the end)', async () => {
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    await user.click(screen.getByRole('button', { name: /Store Credit/ }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Select a customer to pay with store credit')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove payment')).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search customer… (F9)'), 'Abe');
    await user.click(await screen.findByText('Abebe Kebede'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Only 5.00 of store credit is available')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove payment')).not.toBeInTheDocument();
  });

  it('takes more cash than is due and gives change (owner decision 1a; was: "Over", sale blocked)', async () => {
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    await user.type(screen.getByPlaceholderText('10.00'), '50');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Given ETB 50.00 · change ETB 40.00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));

    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].payments).toEqual([{ method: 'cash', amount: 10 }]);
    const change = (await screen.findByText('Change')).closest('div')!;
    expect(within(change).getByText(/40\.00/)).toBeInTheDocument();
  });
});

describe('POS terminal: the sale and its receipt', () => {
  const tz = process.env.TZ;
  afterEach(() => { process.env.TZ = tz; });

  it('leaves the branch to the session (was: sent the branch from the client)', async () => {
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).not.toHaveProperty('branchId');
    expect(calls.find((c) => c.path.startsWith('/books/with-availability'))?.path).not.toContain('branchId');
  });

  it('shows a credit sale due on its day, west of UTC too (was: the day before)', async () => {
    process.env.TZ = 'America/New_York';
    saleAnswer = sale({ customerId: 1, amountPaid: 0, amountDue: 10, paymentStatus: 'credit', dueDate: '2026-10-20', payments: [] });
    const user = await openTerminal();
    await user.type(screen.getByPlaceholderText('Search customer… (F9)'), 'Abe');
    await user.click(await screen.findByText('Abebe Kebede'));
    await addBook(user, 'Oromay');
    await user.click(screen.getByRole('button', { name: /Credit Sale/ }));
    expect(await screen.findByText(`Due Date: ${new Date(2026, 9, 20).toLocaleDateString()}`)).toBeInTheDocument();
  });

  it('prints only the receipt (owner decision 2a; was: the whole page)', async () => {
    const user = await openTerminal();
    await addBook(user, 'Oromay');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));
    await screen.findByText('POS-20261018-0001');
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    expect(css).toContain('@media print');
    expect(document.getElementById('pos-receipt')).toContainElement(screen.getByText('POS-20261018-0001'));
  });
});
