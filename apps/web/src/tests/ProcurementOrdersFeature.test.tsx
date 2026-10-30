// #23 (M6, step 4): the Procurement list and an order's detail move to
// features/procurement. Each step is offered as the API allows it: the roles
// held (any of them), the ordering or receiving branch (#66), and nobody
// approves an order they created. The supplier filter is the API's, cancel
// and close-short are asked in the app's own dialog (owner decision 1a), and
// an order shows its PO number. Every mocked answer is checked against its
// contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ProfileResponseSchema, PurchaseOrderListResponseSchema, PurchaseOrderSchema, SupplierListResponseSchema,
  type ProfileResponse, type PurchaseOrder,
} from '@bms/shared';
import ProcurementPage from '../features/procurement/pages/ProcurementPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

function profile(roles: string[], opts: { id?: number; branchId?: number } = {}): ProfileResponse {
  const branchId = opts.branchId ?? 1;
  return contract(ProfileResponseSchema, {
    id: opts.id ?? 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: branchId, locationAccess: { mode: 'full', locations: [] },
  });
}

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return contract(PurchaseOrderSchema, {
    id: '42', poNumber: 'PO-000042', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors', status: 'draft',
    totalAmount: 200, currency: 'ETB', expectedDeliveryDate: null, notes: null, receivingBranchId: 1, receivingLocationId: null,
    receivingLocationName: null, financialStatus: 'unpaid', paymentTerms: 'credit', createdBy: 3, approvedBy: null,
    approvedAt: null, approvalKind: null, approvalReason: null, approvalThreshold: 1000,
    closedReason: null, closedBy: null, closedAt: null, createdAt: CREATED, updatedAt: CREATED,
    receivedValue: 0, amountPaid: 0, creditNotesTotal: 0, refundsTotal: 0, refundDue: 0, outstandingAmount: 0, orderedQuantityTotal: 10, receivedQuantityTotal: 0,
    lineItems: [], receipts: [], payments: [], creditNotes: [],
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
    if (u.pathname === '/suppliers') {
      return json(contract(SupplierListResponseSchema, {
        items: [{ id: 7, name: 'Acme Distributors', contactInfo: {}, leadTimeDays: 7, pricingTerms: null, supplierType: 'external',
          publisherId: null, publisherName: null, isActive: true, isBlacklisted: false, status: 'ACTIVE', archivedAt: null, createdAt: CREATED }],
        total: 1, page: 1, pageSize: 10, totalPages: 1,
      }));
    }
    if (u.pathname === '/purchase-orders') {
      // A listed order carries no lines, receipts, payments or credit notes.
      const listed = { ...po, lineItems: undefined, receipts: undefined, payments: undefined, creditNotes: undefined };
      return json(contract(PurchaseOrderListResponseSchema, { items: [listed], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === `/purchase-orders/${po.id}`) return json(contract(PurchaseOrderSchema, po));
    if (method === 'POST') return json(contract(PurchaseOrderSchema, po));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><ProcurementPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText('Acme Distributors');
  await settle();
}

async function openOrder() {
  await renderList();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'View' }));
  await screen.findByText('Line Items');
  await settle();
  return user;
}

const buttons = () => screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
const posted = () => calls.filter((c) => c.method === 'POST').map((c) => ({ path: c.path, body: c.body }));

beforeEach(() => {
  setAccessToken('x');
  me = profile(['Purchasor']);
  po = order();
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Procurement: who may take each step', () => {
  it('offers a Stock Clerk no buying steps, which the API refuses (was: New PO, Edit, Submit and Cancel)', async () => {
    me = profile(['Stock_Clerk']);
    const user = await openOrder();
    expect(buttons()).not.toContain('Submit for Approval');
    expect(buttons()).not.toContain('Edit');
    expect(buttons()).not.toContain('Cancel');
    await user.click(screen.getByText('← Back to List'));
    await screen.findByText('Acme Distributors');
    expect(buttons().some((b) => /New PO/.test(b))).toBe(false);
  });

  it('offers a Purchasor no receiving, which the API refuses (was: Receive)', async () => {
    po = order({ status: 'ordered' });
    await renderList();
    expect(buttons()).not.toContain('Receive');
  });

  it('offers a Stock Clerk receiving in the receiving branch', async () => {
    me = profile(['Stock_Clerk']);
    po = order({ status: 'ordered' });
    await openOrder();
    expect(buttons()).toContain('Receive Goods');
  });

  it('offers Approve only to the roles that hold APPROVE_PURCHASE_ORDER, not to the Purchasor who created the order (owner decision 3a, 2026-10-23)', async () => {
    me = profile(['Purchasor'], { id: 3 });
    po = order({ status: 'pending_approval', createdBy: 3 });
    await openOrder();
    expect(buttons()).not.toContain('Approve');
  });

  it('offers another Manager Approve, and approves', async () => {
    me = profile(['Manager'], { id: 4 });
    po = order({ status: 'pending_approval', createdBy: 3 });
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posted()).toEqual([{ path: '/purchase-orders/42/approve', body: undefined }]));
  });

  it('lets an Admin approve the order they created, with no reason asked (owner decision 1a, 2026-10-23; was: no Approve unless the only approver, then a reason)', async () => {
    me = profile(['Admin'], { id: 3 });
    po = order({ status: 'pending_approval', createdBy: 3, totalAmount: 1250 });
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(posted()).toEqual([{ path: '/purchase-orders/42/approve', body: undefined }]));
  });

  it('says what an order waits for, and how it was approved (#164; was: nothing on screen)', async () => {
    me = profile(['Admin'], { id: 3 });
    po = order({ status: 'pending_approval', createdBy: 3, totalAmount: 1250 });
    await openOrder();
    expect(screen.getByText(/Waiting for approval by an Admin or Manager of the branch, its creator included/)).toBeInTheDocument();
    cleanup();

    po = order({ status: 'draft' });
    await openOrder();
    expect(screen.getByText(/Approved on submit up to ETB 1000.00; above that/)).toBeInTheDocument();
    cleanup();

    po = order({ status: 'approved', approvalKind: 'automatic', approvedBy: 3, approvedAt: CREATED });
    await openOrder();
    expect(screen.getByText(/Approved on submit on .*: at or under the approval threshold/)).toBeInTheDocument();
    cleanup();

    po = order({ status: 'ordered', approvalKind: 'creator', approvedBy: 3, approvedAt: CREATED });
    await openOrder();
    expect(screen.getByText(/^Approved by its creator on [^:]*\.$/)).toBeInTheDocument();
    cleanup();

    po = order({ status: 'ordered', approvalKind: 'sole_approver', approvedBy: 3, approvedAt: CREATED, approvalReason: 'Urgent restock' });
    await openOrder();
    expect(screen.getByText(/Approved by its creator, the only approver of the branch on .*: Urgent restock/)).toBeInTheDocument();
  });

  it('offers the receiving branch receiving only, and the ordering branch no receiving (was: every step in both)', async () => {
    po = order({ status: 'ordered', branchId: 1, receivingBranchId: 2 });
    me = profile(['Manager'], { branchId: 2 });
    await openOrder();
    expect(buttons()).toContain('Receive Goods');
    expect(buttons()).not.toContain('Cancel');
  });

  it('does not offer the ordering branch receiving for another branch', async () => {
    po = order({ status: 'ordered', branchId: 1, receivingBranchId: 2 });
    me = profile(['Manager'], { branchId: 1 });
    await openOrder();
    expect(buttons()).not.toContain('Receive Goods');
    expect(buttons()).toContain('Cancel');
  });

  it('counts every role held: Sales and Finance Officer may record a payment (was: only the first role)', async () => {
    me = profile(['Sales', 'Finance_Officer']);
    po = order({ status: 'received', receivedValue: 200, outstandingAmount: 200, receivedQuantityTotal: 10 });
    await openOrder();
    expect(screen.getByText('Record Supplier Payment')).toBeInTheDocument();
  });

  it('does not offer a Stock Clerk the supplier ledger, which the API refuses (was: offered)', async () => {
    me = profile(['Stock_Clerk']);
    await renderList();
    expect(buttons()).not.toContain('Ledger');
  });
});

describe('Procurement: list and steps', () => {
  it('filters by supplier in the API, across every page (was: only the rows on screen)', async () => {
    await renderList();
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText('Search by supplier...'));
    await user.click(await screen.findByRole('option', { name: 'Acme Distributors' }));
    await waitFor(() => expect(calls.some((c) => c.path.startsWith('/purchase-orders?') && new URL(c.path, 'http://x').searchParams.get('supplierId') === '7')).toBe(true));
  });

  it('shows the PO number (was: the internal id)', async () => {
    await openOrder();
    expect(screen.getByRole('heading', { name: 'PO-000042' })).toBeInTheDocument();
  });

  it('asks before cancelling, in the app\'s own dialog (was: the browser\'s confirm)', async () => {
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Order' }));
    await waitFor(() => expect(posted()).toEqual([{ path: '/purchase-orders/42/cancel', body: undefined }]));
  });

  it('asks why an order closes short, and needs a reason (was: the browser\'s prompt)', async () => {
    me = profile(['Manager'], { id: 4 });
    po = order({ status: 'partially_received', receivedQuantityTotal: 5 });
    const user = await openOrder();
    await user.click(screen.getByRole('button', { name: 'Close Short' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close Short' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), 'Out of print');
    await user.click(within(dialog).getByRole('button', { name: 'Close Short' }));
    await waitFor(() => expect(posted()).toEqual([{ path: '/purchase-orders/42/close', body: { reason: 'Out of print' } }]));
  });
});
