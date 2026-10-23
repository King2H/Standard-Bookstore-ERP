// #23 (M6, step 4): the purchase-order form and receiving move to
// features/procurement. Suppliers are found by typing; only open branches
// receive; a receiving location can be chosen for the order's own branch;
// totals are worked out with Money; the contract's limits are checked before
// sending; a line without a book is not dropped silently; editing from the
// list keeps the order's lines; and receiving checks its notes. Every
// mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookAvailabilityListResponseSchema, BookSchema, BranchListResponseSchema, CatalogSearchResponseSchema, LocationListResponseSchema,
  ProfileResponseSchema, PurchaseOrderListResponseSchema, PurchaseOrderSchema, SupplierListResponseSchema,
  type Book, type ProfileResponse, type PurchaseOrder,
} from '@bms/shared';
import ProcurementPage from '../features/procurement/pages/ProcurementPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
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

const book = (id: number, title: string): Book => contract(BookSchema, {
  id, isbn: `97803064061${String(id).padStart(2, '0')}`, sku: null, title, authors: [], authorIds: [], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice: 10,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
});

const branch = (id: number, name: string, isActive: boolean) => ({
  id, name, address: '', contactInfo: {}, operatingHours: {}, isActive, createdAt: CREATED,
});

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return contract(PurchaseOrderSchema, {
    id: '42', poNumber: 'PO-000042', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors', status: 'draft',
    totalAmount: 120, currency: 'ETB', expectedDeliveryDate: null, notes: null, receivingBranchId: 1, receivingLocationId: null,
    receivingLocationName: null, financialStatus: 'unpaid', paymentTerms: 'credit', createdBy: 3, approvedBy: null,
    approvedAt: null, approvalKind: null, approvalReason: null, approvalThreshold: 1000, creatorIsOnlyApprover: false,
    closedReason: null, closedBy: null, closedAt: null, createdAt: CREATED, updatedAt: CREATED,
    receivedValue: 0, amountPaid: 0, creditNotesTotal: 0, outstandingAmount: 0, orderedQuantityTotal: 10, receivedQuantityTotal: 0,
    lineItems: [{ id: '501', poId: '42', bookId: 1, bookTitle: 'Animal Farm', bookIsbn: '9780306406101', formatId: null, editionId: null,
      quantity: 10, unitCost: 12, receivedQuantity: 0, remaining: 10 }],
    receipts: [], payments: [], creditNotes: [],
    ...over,
  });
}

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let po: PurchaseOrder;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    const q = u.searchParams;
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/suppliers') {
      return json(contract(SupplierListResponseSchema, {
        items: [{ id: 7, name: 'Acme Distributors', contactInfo: {}, leadTimeDays: 7, pricingTerms: null, supplierType: 'external',
          publisherId: null, publisherName: null, isActive: true, isBlacklisted: false, status: 'ACTIVE', archivedAt: null, createdAt: CREATED }],
        total: 1, page: 1, pageSize: 10, totalPages: 1,
      }));
    }
    if (u.pathname === '/branches') {
      const all = [branch(1, 'Main Branch', true), branch(2, 'Bole Branch', true), branch(3, 'Closed Branch', false)];
      const items = q.get('isActive') === 'true' ? all.filter((b) => b.isActive) : all;
      return json(contract(BranchListResponseSchema, { items, total: items.length, page: 1, pageSize: 100, totalPages: 1 }));
    }
    if (/^\/branches\/\d+\/locations$/.test(u.pathname)) {
      const items = [{ id: 1, name: 'Shop Floor', isDefaultFulfillment: true }, { id: 2, name: 'Back Store', isDefaultFulfillment: false }]
        .map((l) => ({ ...l, branchId: 1, createdAt: CREATED }));
      return json(contract(LocationListResponseSchema, { items, total: 2, accessMode: 'full' }));
    }
    if (u.pathname === '/catalog/search') return json(contract(CatalogSearchResponseSchema, { results: [book(1, 'Animal Farm')], total: 1 }));
    if (u.pathname === '/books/with-availability') {
      return json(contract(BookAvailabilityListResponseSchema, {
        items: [{ ...book(1, 'Animal Farm'), availability: { locationId: 2, locationName: 'Back Store', onHand: 3, reserved: 0, available: 3 } }],
        total: 1, page: 1, pageSize: 10, totalPages: 1,
      }));
    }
    if (u.pathname === '/purchase-orders' && method === 'GET') {
      const listed = { ...po, lineItems: undefined, receipts: undefined, payments: undefined, creditNotes: undefined };
      return json(contract(PurchaseOrderListResponseSchema, { items: [listed], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === `/purchase-orders/${po.id}` && method === 'GET') return json(contract(PurchaseOrderSchema, po));
    if (method === 'POST' || method === 'PUT') return json(contract(PurchaseOrderSchema, po));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><ProcurementPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Acme Distributors');
  await settle();
  return userEvent.setup();
}

async function openNewOrder() {
  const user = await renderList();
  await user.click(screen.getByRole('button', { name: /New PO/ }));
  await screen.findByText('Line Items');
  await settle();
  return user;
}

/** The select that offers this option. */
const selectWith = (option: string) =>
  screen.getAllByRole('combobox').find((s) => s.tagName === 'SELECT' && [...(s as HTMLSelectElement).options].some((o) => o.text === option)) as HTMLSelectElement;

async function chooseSupplier(user: ReturnType<typeof userEvent.setup>) {
  const typed = screen.queryByPlaceholderText('Type to search suppliers…');
  if (typed) {
    await user.click(typed);
    await user.click(await screen.findByRole('option', { name: 'Acme Distributors' }));
  } else {
    await waitFor(() => expect(selectWith('Acme Distributors')).toBeTruthy());
    await user.selectOptions(selectWith('Acme Distributors'), '7');
  }
}

async function chooseBook(user: ReturnType<typeof userEvent.setup>, input: HTMLElement) {
  await user.type(input, 'Anim');
  fireEvent.mouseDown(await screen.findByText('Animal Farm'));
}

const posted = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Purchasor']);
  po = order();
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Procurement: the order form', () => {
  it('finds a supplier by typing (was: the first 200, loaded in full)', async () => {
    const user = await openNewOrder();
    await chooseSupplier(user);
    await waitFor(() => expect(calls.some((c) => c.path.startsWith('/suppliers') && new URL(c.path, 'http://x').searchParams.get('status') === 'active')).toBe(true));
    expect(calls.some((c) => c.path.startsWith('/suppliers') && new URL(c.path, 'http://x').searchParams.get('pageSize') === '200')).toBe(false);
  });

  it('offers only open branches to receive the goods (was: closed ones too, which the API refused)', async () => {
    await openNewOrder();
    await waitFor(() => expect(selectWith('Same as order branch (default)').options.length).toBeGreaterThan(1));
    const options = [...selectWith('Same as order branch (default)').options].map((o) => o.text);
    expect(options).toEqual(['Same as order branch (default)', 'Main Branch', 'Bole Branch']);
  });

  it('lets the order\'s own branch choose a receiving location (was: only after choosing another branch)', async () => {
    const user = await openNewOrder();
    await chooseSupplier(user);
    await waitFor(() => expect(selectWith('Default fulfillment location')).toBeTruthy());
    await waitFor(() => expect(selectWith('Default fulfillment location').options.length).toBe(3));
    await user.selectOptions(selectWith('Default fulfillment location'), '2');
    await chooseBook(user, screen.getByPlaceholderText('Type to search books…'));
    await user.click(screen.getByRole('button', { name: 'Save as Draft' }));
    await waitFor(() => expect(posted('POST', '/purchase-orders')).toHaveLength(1));
    expect(posted('POST', '/purchase-orders')[0]).toMatchObject({ supplierId: 7, receivingBranchId: null, receivingLocationId: 2 });
  });

  it('works out the total with Money (was: floating point, 1.005 showed as 1.00)', async () => {
    const user = await openNewOrder();
    const [, cost] = screen.getAllByRole('spinbutton');
    await user.clear(cost);
    await user.type(cost, '1.005');
    expect(screen.getByText('Total: ETB 1.01')).toBeInTheDocument();
  });

  it('refuses a line without a book (was: the line was dropped without a word)', async () => {
    const user = await openNewOrder();
    await chooseSupplier(user);
    await chooseBook(user, screen.getByPlaceholderText('Type to search books…'));
    await user.click(screen.getByRole('button', { name: '+ Add Item' }));
    await user.click(screen.getByRole('button', { name: 'Save as Draft' }));
    expect(await screen.findByText('Choose a book for every line')).toBeInTheDocument();
    await settle();
    expect(posted('POST', '/purchase-orders')).toEqual([]);
  });

  it('checks the notes are at most 2000 characters before sending (was: sent and refused)', async () => {
    const user = await openNewOrder();
    await chooseSupplier(user);
    await chooseBook(user, screen.getByPlaceholderText('Type to search books…'));
    await user.click(document.querySelector('textarea')!);
    await user.paste('x'.repeat(2001));
    await user.click(screen.getByRole('button', { name: 'Save as Draft' }));
    expect(await screen.findByText('Notes can be at most 2000 characters')).toBeInTheDocument();
    await settle();
    expect(posted('POST', '/purchase-orders')).toEqual([]);
  });

  it('keeps the order\'s lines when editing from the list (was: an empty form, and saving replaced them)', async () => {
    const user = await renderList();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('Animal Farm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save as Draft' }));
    await waitFor(() => expect(posted('PUT', '/purchase-orders/42')).toHaveLength(1));
    expect(posted('PUT', '/purchase-orders/42')[0]).toMatchObject({ lineItems: [{ bookId: 1, quantity: 10 }] });
  });
});

describe('Procurement: receiving', () => {
  beforeEach(() => {
    me = profile(['Stock_Clerk']);
    po = order({ status: 'ordered' });
  });

  it('checks the notes are at most 2000 characters before receiving (was: sent and refused)', async () => {
    const user = await renderList();
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    const row = (await screen.findByText('Animal Farm')).closest('tr')!;
    await settle();
    const qty = within(row).getByRole('spinbutton');
    await user.clear(qty);
    await user.type(qty, '4');
    await user.click(document.querySelector('textarea')!);
    await user.paste('x'.repeat(2001));
    await user.click(screen.getByRole('button', { name: 'Submit Receipt' }));
    expect(await screen.findByText('Notes can be at most 2000 characters')).toBeInTheDocument();
    await settle();
    expect(posted('POST', '/purchase-orders/42/receive')).toEqual([]);
  });

  it('receives the copies at the chosen location', async () => {
    const user = await renderList();
    await user.click(screen.getByRole('button', { name: 'Receive' }));
    const row = (await screen.findByText('Animal Farm')).closest('tr')!;
    await settle();
    const qty = within(row).getByRole('spinbutton');
    await user.clear(qty);
    await user.type(qty, '4');
    await user.click(screen.getByRole('button', { name: 'Submit Receipt' }));
    await waitFor(() => expect(posted('POST', '/purchase-orders/42/receive')).toHaveLength(1));
    expect(posted('POST', '/purchase-orders/42/receive')[0]).toEqual({ locationId: 1, items: [{ poLineItemId: 501, quantityReceived: 4 }], notes: null });
  });
});
