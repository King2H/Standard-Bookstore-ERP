// #23 (M6, step 4): supplier payments, credit notes and the supplier ledger
// move to features/procurement. Amounts are checked with the contract's rules
// before sending (whole cents, at most what the order still allows); a
// payment is reversed through the app's own dialog (owner decision 1a); a
// ledger day shows on the day it was dated, in any timezone; and a failed
// export says so. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ProfileResponseSchema, PurchaseOrderListResponseSchema, PurchaseOrderSchema, SupplierLedgerResponseSchema,
  type ProfileResponse, type PurchaseOrder,
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

/** Ordered 200, received all of it, 150 paid: 50 still owed. */
function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return contract(PurchaseOrderSchema, {
    id: '42', poNumber: 'PO-000042', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors', status: 'received',
    totalAmount: 200, currency: 'ETB', expectedDeliveryDate: null, notes: null, receivingBranchId: 1, receivingLocationId: null,
    receivingLocationName: null, financialStatus: 'partial', paymentTerms: 'credit', createdBy: 3, approvedBy: 4,
    approvedAt: CREATED, approvalKind: 'approver', approvalReason: null, approvalThreshold: 1000,
    closedReason: null, closedBy: null, closedAt: null, createdAt: CREATED, updatedAt: CREATED,
    receivedValue: 200, amountPaid: 150, creditNotesTotal: 0, refundsTotal: 0, refundDue: 0, outstandingAmount: 50, orderedQuantityTotal: 10, receivedQuantityTotal: 10,
    lineItems: [], receipts: [], creditNotes: [],
    payments: [{ id: '9', paymentNumber: 'SPAY-20261010-0003', poId: '42', amount: 150, paymentMethod: 'cash', bankAccountId: null,
      source: 'manual', notes: null, createdBy: 3, createdAt: CREATED, reversedAt: null, reversedBy: null, reversalReason: null }],
    ...over,
  });
}

type Call = { method: string; path: string; body: unknown };
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
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/purchase-orders' && method === 'GET') {
      const listed = { ...po, lineItems: undefined, receipts: undefined, payments: undefined, creditNotes: undefined };
      return json(contract(PurchaseOrderListResponseSchema, { items: [listed], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === `/purchase-orders/${po.id}` && method === 'GET') return json(contract(PurchaseOrderSchema, po));
    if (u.pathname === '/suppliers/7/ledger') {
      return json(contract(SupplierLedgerResponseSchema, {
        currentBalance: 50,
        entries: [{ date: '2026-10-01', type: 'GOODS_RECEIPT', reference: 'GRN-1', description: 'Goods received', amount: 200, balance: 200 }],
      }));
    }
    if (u.pathname === '/suppliers/7/ledger/export') return json({ error: 'INTERNAL_ERROR', message: 'Export failed on the server' }, 500);
    if (method === 'POST') return json(contract(PurchaseOrderSchema, po));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function openOrder() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><ProcurementPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Acme Distributors');
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'View' }));
  await screen.findByText('Line Items');
  await settle();
  return user;
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
const amountInputs = () => screen.getAllByPlaceholderText('0.00');

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Finance_Officer']);
  po = order();
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Procurement: payments and credit notes', () => {
  it('refuses a payment beyond what the order still allows, before sending (was: sent and refused)', async () => {
    const user = await openOrder();
    await user.type(amountInputs()[0], '60');
    await user.click(screen.getByRole('button', { name: 'Record Payment' }));
    expect(await screen.findByText('At most ETB 50.00 more can be paid or credited on this order')).toBeInTheDocument();
    await settle();
    expect(posted('/purchase-orders/42/payments')).toEqual([]);
  });

  it('refuses a payment in fractions of a cent, before sending (was: sent and refused)', async () => {
    const user = await openOrder();
    await user.type(amountInputs()[0], '10.005');
    await user.click(screen.getByRole('button', { name: 'Record Payment' }));
    expect(await screen.findByText('Enter an amount more than zero, in whole cents')).toBeInTheDocument();
    await settle();
    expect(posted('/purchase-orders/42/payments')).toEqual([]);
  });

  it('records a payment within what is owed', async () => {
    const user = await openOrder();
    await user.type(amountInputs()[0], '50');
    await user.click(screen.getByRole('button', { name: 'Record Payment' }));
    await waitFor(() => expect(posted('/purchase-orders/42/payments')).toHaveLength(1));
    expect(Number((posted('/purchase-orders/42/payments')[0] as { amount: string | number }).amount)).toBe(50);
  });

  it('checks a credit note\'s reason is at most 1000 characters (was: sent and refused)', async () => {
    const user = await openOrder();
    await user.type(amountInputs()[1], '10');
    await user.click(screen.getByPlaceholderText(/damaged goods/i));
    await user.paste('x'.repeat(1001));
    await user.click(screen.getByRole('button', { name: 'Issue Credit Note' }));
    expect(await screen.findByText('At most 1000 characters')).toBeInTheDocument();
    await settle();
    expect(posted('/purchase-orders/42/credit-notes')).toEqual([]);
  });

  it('reverses a payment through the app\'s dialog, with a reason required (was: the browser\'s prompt)', async () => {
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Reverse' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reverse Payment' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), 'Paid twice');
    await user.click(within(dialog).getByRole('button', { name: 'Reverse Payment' }));
    await waitFor(() => expect(posted('/purchase-orders/42/payments/9/reverse')).toEqual([{ reason: 'Paid twice' }]));
  });
});

describe('Procurement: the supplier ledger', () => {
  const tz = process.env.TZ;
  afterEach(() => { process.env.TZ = tz; });

  async function openLedger() {
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: /View Supplier Ledger/ }));
    await screen.findByText('Goods received');
    return user;
  }

  it('shows a ledger day on the day it was dated, west of UTC too (was: the day before)', async () => {
    process.env.TZ = 'America/New_York';
    await openLedger();
    const row = screen.getByText('Goods received').closest('tr')!;
    expect(within(row).getByText(new Date(2026, 9, 1).toLocaleDateString())).toBeInTheDocument();
  });

  it('says when the export fails (was: nothing happened)', async () => {
    const user = await openLedger();
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Export failed on the server')).toBeInTheDocument();
  });
});
