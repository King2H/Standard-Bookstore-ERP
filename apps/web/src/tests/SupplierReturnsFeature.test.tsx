// #173 PR 2 (owner decisions 1a–5a, 2026-10-30): the screens for returns to
// supplier. An order's page offers "Return to Supplier" to Admin, Manager and
// Purchasor of the receiving branch while received copies have not all gone
// back, shows what went back on each line, the refund due and the order's
// returns. The return form takes, per line, the copies from one or more
// locations, from stock or damaged copies, with what each location holds. A
// draft is edited or cancelled with a reason; an Admin or Manager sends it
// after a confirmation; a return note prints for the supplier. Procurement
// lists the branch's returns. The ordering branch's finance staff record the
// supplier's refund. The stock history names a return and opens it. Before,
// the screens offered no return at all. Every mocked answer is checked
// against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  LocationListResponseSchema, ProfileResponseSchema, PurchaseOrderListResponseSchema, PurchaseOrderSchema, StockLevelListResponseSchema,
  StockMovementListResponseSchema, SupplierReturnDetailSchema, SupplierReturnListResponseSchema,
  type ProfileResponse, type PurchaseOrder, type SupplierReturnDetail, type SupplierReturnStatus,
} from '@bms/shared';
import ProcurementPage from '../features/procurement/pages/ProcurementPage.js';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const AT = '2026-10-30T07:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: AT, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

/** PO-000042: Dune 10 × 10.00 received, 2 already back; Oromay 5 × 4.00 received. */
function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return contract(PurchaseOrderSchema, {
    id: '42', poNumber: 'PO-000042', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors', status: 'received',
    totalAmount: 120, currency: 'ETB', expectedDeliveryDate: null, notes: null, receivingBranchId: 1, receivingLocationId: 1,
    receivingLocationName: 'Shop Floor', financialStatus: 'partial', paymentTerms: 'credit', createdBy: 3, approvedBy: 4,
    approvedAt: AT, approvalKind: 'approver', approvalReason: null, approvalThreshold: 1000,
    closedReason: null, closedBy: null, closedAt: null, createdAt: AT, updatedAt: AT,
    receivedValue: 120, amountPaid: 50, creditNotesTotal: 20, refundsTotal: 0, outstandingAmount: 50, refundDue: 0,
    orderedQuantityTotal: 15, receivedQuantityTotal: 15,
    lineItems: [
      { id: '501', poId: '42', bookId: 3, bookTitle: 'Dune', bookIsbn: '9780441013593', formatId: null, editionId: null,
        quantity: 10, unitCost: 10, receivedQuantity: 10, returnedQuantity: 2, remaining: 0 },
      { id: '502', poId: '42', bookId: 4, bookTitle: 'Oromay', bookIsbn: '9789994400017', formatId: null, editionId: null,
        quantity: 5, unitCost: 4, receivedQuantity: 5, returnedQuantity: 0, remaining: 0 },
    ],
    receipts: [], payments: [], creditNotes: [], supplierRefunds: [],
    ...over,
  });
}

/** RTS-20261030-0001 of PO-000042: 2 Dune from stock and 1 damaged Oromay, credit 24.00. */
function aReturn(status: SupplierReturnStatus): SupplierReturnDetail {
  const sent = status === 'sent';
  return contract(SupplierReturnDetailSchema, {
    id: 8, returnNumber: 'RTS-20261030-0001', poId: '42', poNumber: 'PO-000042', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors',
    status, notes: 'Torn covers', createdBy: 9, createdByName: 'Me', createdAt: AT, sentBy: sent ? 9 : null, sentByName: sent ? 'Me' : null,
    sentAt: sent ? AT : null, cancelledAt: null, cancelReason: null, lineCount: 2, totalQuantity: 3, creditValue: 24,
    costValue: sent ? 21 : null, gainLoss: sent ? 3 : null, creditNoteNumber: sent ? 'SCN-20261030-0004' : null,
    lines: [
      { id: 1, poLineItemId: '501', bookId: 3, bookTitle: 'Dune', isbn: '9780441013593', locationId: 1, locationName: 'Shop Floor', source: 'stock',
        quantity: 2, unitCredit: 10, creditValue: 20, unitCost: sent ? 9 : null, costValue: sent ? 18 : null },
      { id: 2, poLineItemId: '502', bookId: 4, bookTitle: 'Oromay', isbn: '9789994400017', locationId: 1, locationName: 'Shop Floor', source: 'damaged',
        quantity: 1, unitCredit: 4, creditValue: 4, unitCost: sent ? 3 : null, costValue: sent ? 3 : null },
    ],
  });
}

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[];
let me: ProfileResponse;
let po: PurchaseOrder;
let theReturn: SupplierReturnDetail;

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
    if (u.pathname === '/branches/1/locations') {
      return json(contract(LocationListResponseSchema, {
        items: [{ id: 1, name: 'Shop Floor', branchId: 1, isDefaultFulfillment: true, createdAt: AT }, { id: 2, name: 'Back Room', branchId: 1, isDefaultFulfillment: false, createdAt: AT }],
        total: 2, accessMode: 'full',
      }));
    }
    if (u.pathname === '/inventory' && u.searchParams.get('bookId')) {
      const location = Number(u.searchParams.get('locationId'));
      return json(contract(StockLevelListResponseSchema, {
        items: [{
          bookId: Number(u.searchParams.get('bookId')), bookTitle: 'Dune', bookIsbn: '9780441013593', bookIsActive: true, locationId: location,
          locationName: location === 1 ? 'Shop Floor' : 'Back Room', branchId: 1, quantity: location === 1 ? 8 : 3, reserved: 0,
          available: location === 1 ? 8 : 3, reorderPoint: 0, averageCost: 9, damaged: location === 1 ? 1 : 0, damagedValue: location === 1 ? 3 : 0,
          version: 1, isLowStock: false, updatedAt: AT,
        }],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (u.pathname === '/inventory/history') {
      return json(contract(StockMovementListResponseSchema, {
        items: [{
          id: '77', bookId: 3, bookTitle: 'Dune', locationId: 1, locationName: 'Shop Floor', qtyBefore: 10, qtyAfter: 8, delta: -2,
          movementType: 'stock_out', reasonCode: 'supplier_return', referenceType: 'supplier_return', referenceId: '8', notes: 'Return RTS-20261030-0001',
          staffId: 9, staffUsername: 'me', createdAt: AT,
        }],
        total: 1, page: 1, totalPages: 1,
      }));
    }
    if (u.pathname === '/purchase-orders' && method === 'GET') {
      const listed = { ...po, lineItems: undefined, receipts: undefined, payments: undefined, creditNotes: undefined, supplierRefunds: undefined };
      return json(contract(PurchaseOrderListResponseSchema, { items: [listed], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/purchase-orders/42' && method === 'GET') return json(contract(PurchaseOrderSchema, po));
    if (u.pathname === '/purchase-orders/42/supplier-refunds') return json(contract(PurchaseOrderSchema, po), 201);
    if (u.pathname === '/supplier-returns' && method === 'GET') {
      const summary = { ...theReturn, lines: undefined };
      return json(contract(SupplierReturnListResponseSchema, { items: [summary], total: 1, page: 1, pageSize: 25, totalPages: 1 }));
    }
    if (u.pathname === '/supplier-returns' && method === 'POST') return json(contract(SupplierReturnDetailSchema, theReturn), 201);
    if (u.pathname.startsWith('/supplier-returns/')) return json(contract(SupplierReturnDetailSchema, theReturn));
    return json({ items: [], total: 0, page: 1, totalPages: 0 });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

function renderPage(initialContext: Record<string, string> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><ProcurementPage initialContext={initialContext} /></ToastProvider></QueryClientProvider>);
  return userEvent.setup();
}

async function openOrder() {
  const user = renderPage();
  await screen.findByText('Acme Distributors');
  await settle();
  await user.click(screen.getByRole('button', { name: 'View' }));
  await screen.findByText('Line Items');
  await settle();
  return user;
}

async function openReturn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Returns to Supplier' }));
  await user.click(await screen.findByRole('button', { name: 'RTS-20261030-0001' }));
  await screen.findByRole('heading', { name: /RTS-20261030-0001/ });
  await settle();
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Purchasor']);
  po = order();
  theReturn = aReturn('draft');
  stubApi();
});
afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the order\'s page (1a)', () => {
  it('shows what went back on each line and offers Return to Supplier to the receiving branch\'s buyers (was: neither)', async () => {
    await openOrder();
    const dune = screen.getByRole('row', { name: /Dune/ });
    expect(within(dune).getByRole('cell', { name: '2' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Returned' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to Supplier' })).toBeInTheDocument();
  });

  it('is not offered to a Stock_Clerk or Finance_Officer, nor once everything went back', async () => {
    me = profile(['Stock_Clerk', 'Finance_Officer']);
    await openOrder();
    expect(screen.queryByRole('button', { name: 'Return to Supplier' })).toBeNull();
  });

  it('is not offered once every copy went back', async () => {
    po = order({ lineItems: order().lineItems!.map((l) => ({ ...l, returnedQuantity: l.receivedQuantity })) });
    await openOrder();
    expect(screen.queryByRole('button', { name: 'Return to Supplier' })).toBeNull();
  });
});

describe('the return form (2a)', () => {
  it('takes copies per line from one or more locations, from stock or damaged, with what each holds', async () => {
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Return to Supplier' }));
    expect(await screen.findByText('8 of 10 can go back')).toBeInTheDocument();
    expect(await screen.findAllByText('On hand 8 · damaged 1')).not.toHaveLength(0);
    await user.type(screen.getByLabelText('Quantity of Dune from Shop Floor'), '2');
    await user.click(screen.getByRole('button', { name: '+ another location for Dune' }));
    const locations = screen.getAllByLabelText('Location for Dune');
    await user.selectOptions(locations[1], '2');
    expect(await screen.findByText('On hand 3 · damaged 0')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Quantity of Dune from Back Room'), '1');
    await user.selectOptions(screen.getByLabelText('From for Oromay'), 'damaged');
    await user.type(screen.getByLabelText('Quantity of Oromay from Shop Floor'), '1');
    await user.type(screen.getByLabelText('Notes'), 'Torn covers');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => expect(sent('POST', '/supplier-returns')).toEqual([{
      poId: 42, notes: 'Torn covers',
      lines: [
        { poLineItemId: 501, locationId: 1, source: 'stock', quantity: 2 },
        { poLineItemId: 501, locationId: 2, source: 'stock', quantity: 1 },
        { poLineItemId: 502, locationId: 1, source: 'damaged', quantity: 1 },
      ],
    }]));
    expect(await screen.findByRole('heading', { name: /RTS-20261030-0001/ })).toBeInTheDocument();
  });

  it('refuses more than can go back, before sending', async () => {
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Return to Supplier' }));
    await user.type(await screen.findByLabelText('Quantity of Dune from Shop Floor'), '9');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(await screen.findByText('Dune: at most 8 can go back')).toBeInTheDocument();
    await settle();
    expect(sent('POST', '/supplier-returns')).toEqual([]);
  });
});

describe('a draft (3a)', () => {
  it('is sent by a Manager after a confirmation showing the credit', async () => {
    me = profile(['Manager']);
    const user = renderPage();
    await openReturn(user);
    await user.click(screen.getByRole('button', { name: 'Send to Supplier' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/3 copies leave; the order is credited ETB 24\.00/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent('POST', '/supplier-returns/8/send')).toHaveLength(1));
  });

  it('is not sent by a Purchasor, who edits and cancels it with a reason', async () => {
    const user = renderPage();
    await openReturn(user);
    expect(screen.queryByRole('button', { name: 'Send to Supplier' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel Return' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Supplier will replace them');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Return' }));
    await waitFor(() => expect(sent('POST', '/supplier-returns/8/cancel')).toEqual([{ reason: 'Supplier will replace them' }]));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const quantity = await screen.findByLabelText('Quantity of Dune from Shop Floor');
    expect(quantity).toHaveValue('2');
    await user.clear(quantity);
    await user.type(quantity, '3');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => expect(sent('PUT', '/supplier-returns/8')).toEqual([{
      notes: 'Torn covers',
      lines: [
        { poLineItemId: 501, locationId: 1, source: 'stock', quantity: 3 },
        { poLineItemId: 502, locationId: 1, source: 'damaged', quantity: 1 },
      ],
    }]));
  });

  it('prints a return note for the supplier to sign', async () => {
    const user = renderPage();
    await openReturn(user);
    await user.click(screen.getByRole('button', { name: '🖨 Print Return Note' }));
    const note = screen.getByRole('dialog', { name: 'Return note RTS-20261030-0001' });
    for (const text of ['Acme Distributors', 'PO-000042', 'Dune', 'Oromay', 'ETB 24.00', 'Received by']) {
      expect(within(note).getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    }
  });
});

describe('a sent return', () => {
  it('shows what the copies cost, the gain or loss and the credit note', async () => {
    theReturn = aReturn('sent');
    me = profile(['Manager']);
    const user = renderPage();
    await openReturn(user);
    expect(screen.getByText('Gain ETB 3.00')).toBeInTheDocument();
    expect(screen.getByText(/SCN-20261030-0004/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to Supplier' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel Return' })).toBeNull();
  });

  it('is opened from a link (the stock history)', async () => {
    renderPage({ returnId: '8' });
    expect(await screen.findByRole('heading', { name: /RTS-20261030-0001/ })).toBeInTheDocument();
  });
});

describe('the refund (4a)', () => {
  beforeEach(() => {
    me = profile(['Finance_Officer']);
    po = order({ amountPaid: 120, creditNotesTotal: 30, outstandingAmount: -30, refundDue: 30, financialStatus: 'paid' });
  });

  it('shows the refund due and records it, at most what is due, with its reference', async () => {
    const user = await openOrder();
    expect(screen.getByText('Refund Due')).toBeInTheDocument();
    const amountField = screen.getByLabelText('Refund amount (ETB)');
    await user.type(amountField, '31');
    await user.selectOptions(screen.getByLabelText('Refund method'), 'cheque');
    await user.click(screen.getByRole('button', { name: 'Record Refund' }));
    expect(await screen.findByText('At most ETB 30.00 is due back')).toBeInTheDocument();
    await user.clear(amountField);
    await user.type(amountField, '30');
    await user.click(screen.getByRole('button', { name: 'Record Refund' }));
    expect(await screen.findByText('A cheque, bank or Telebirr refund names its reference')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Refund reference'), 'CHQ-77');
    await user.click(screen.getByRole('button', { name: 'Record Refund' }));
    await waitFor(() => expect(sent('POST', '/purchase-orders/42/supplier-refunds')).toEqual([{ amount: '30', method: 'cheque', reference: 'CHQ-77' }]));
  });

  it('lists the refunds received', async () => {
    po = order({ refundsTotal: 30, supplierRefunds: [{ id: 1, refundNumber: 'SREF-20261030-0001', poId: '42', amount: 30, method: 'cheque', reference: 'CHQ-77',
      bankAccountId: null, notes: null, createdBy: 9, createdAt: AT }] });
    await openOrder();
    expect(screen.getByText('SREF-20261030-0001')).toBeInTheDocument();
    expect(screen.getByText(/CHQ-77/)).toBeInTheDocument();
  });
});

describe('the stock history (5a)', () => {
  it('names a return to supplier and opens it', async () => {
    const onNavigate = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ToastProvider><InventoryPage initialContext={{}} onNavigate={onNavigate} /></ToastProvider></QueryClientProvider>);
    const user = userEvent.setup();
    await settle();
    await user.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('History'))!);
    const link = await screen.findByRole('button', { name: 'Open return #8' });
    expect(within(link.closest('tr')!).getByText('Return to Supplier')).toBeInTheDocument();
    await user.click(link);
    expect(onNavigate).toHaveBeenCalledWith('procurement', { returnId: '8' });
  });
});
