// #169 PR 3 (owner decisions 1a, 2a, 3a, 4a): after the sale. The branch's
// binding jobs are on a board of their own under Sales, with the customer's
// phone to call when a job is ready; whoever sells moves a job on. A Manager
// or Admin cancels a binding still Requested, with a reason, and its fee goes
// back. A bound copy comes back through Returns only defective, taken by a
// Manager or Admin with a reason: book and fee are refunded, the copy is kept
// apart as damaged. A Ready notification opens the board. Before, jobs were
// seen only on their sale, and a bound copy came back as any book. Every
// mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MarkReadResponseSchema, NotificationListResponseSchema, NotificationSchema, PosTransactionListResponseSchema, PosTransactionSchema,
  ProfileResponseSchema, ReturnSchema, ServiceJobListResponseSchema, ServiceJobSchema, UnreadCountResponseSchema,
  type PosTransaction, type ProfileResponse, type SaleServiceLine, type ServiceJobBoardItem, type ServiceJobStatus,
} from '@bms/shared';
import BindingJobsPage from '../features/services/pages/BindingJobsPage.js';
import ReturnsPage from '../features/returns/pages/ReturnsPage.js';
import NotificationBell from '../features/notifications/components/NotificationBell.js';
import { ToastProvider } from '../components/Toast.js';
import { canOpenPage, NAV_SECTIONS } from '../app/navigation.js';
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

const boardItem = (over: Partial<ServiceJobBoardItem>): ServiceJobBoardItem => ({
  id: 31, jobNumber: 'SVC-20261026-0001', status: 'REQUESTED', readyDate: '2026-10-31', customerId: 1, branchId: 1, updatedAt: CREATED,
  serviceName: 'Leather binding', quantity: 2, bookTitle: 'Oromay', customerName: 'Abebe Kebede', customerPhone: '0911000000',
  source: 'POS', saleId: '77', saleNumber: 'POS-20261026-0001', overdue: false, ...over,
});
const BOARD = [
  boardItem({}),
  boardItem({ id: 32, jobNumber: 'SVC-20261020-0004', status: 'AT_BINDER', readyDate: '2026-10-25', overdue: true, customerName: 'Tigist Alemu', customerPhone: null }),
  boardItem({ id: 33, jobNumber: 'SVC-20261019-0002', status: 'READY', source: 'ORDER', saleId: '10', saleNumber: 'ORD-20261019-0002' }),
  boardItem({ id: 34, jobNumber: 'SVC-20261018-0001', status: 'READY', bookTitle: 'Fikir Eske Mekabir' }),
];

const bound = (status: ServiceJobStatus): SaleServiceLine => ({
  id: 4, serviceId: 1, serviceCode: 'BIND-LEATHER', serviceName: 'Leather binding', quantity: 2, unitFee: 100, discountAmount: 0,
  lineTotal: 200, standardCost: 40, job: contract(ServiceJobSchema, {
    id: 31, jobNumber: 'SVC-20261026-0001', status, readyDate: '2026-10-31', customerId: 1, branchId: 1, updatedAt: CREATED,
  }),
});
const sale = (status: ServiceJobStatus): PosTransaction => contract(PosTransactionSchema, {
  id: '77', branchId: 1, locationId: 7, customerId: 1, staffId: 9, transactionNumber: 'POS-20261026-0001',
  subtotal: 500, discountTotal: 0, taxTotal: 0, grandTotal: 500, amountPaid: 500, amountDue: 0, paymentStatus: 'paid',
  currency: 'ETB', status: 'completed', createdAt: CREATED, dueDate: null, voidable: false,
  lineItems: [{
    id: '5', transactionId: '77', bookId: 2, bookTitle: 'Oromay', bookIsbn: '1', quantity: 3, unitPrice: 100, discountPct: 0,
    discountAmount: 0, lineTotal: 300, unitCost: 40, service: bound(status),
  }],
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let theSale: PosTransaction;

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
    if (u.pathname === '/service-jobs') {
      return json(contract(ServiceJobListResponseSchema, { items: BOARD, total: BOARD.length, page: 1, pageSize: 25, totalPages: 1 }));
    }
    const job = (id: string, status: ServiceJobStatus) => json(contract(ServiceJobSchema, { ...(BOARD.find((j) => String(j.id) === id) as ServiceJobBoardItem), status }));
    const cancel = u.pathname.match(/^\/service-jobs\/(\d+)\/cancel$/);
    if (method === 'POST' && cancel) return job(cancel[1], 'CANCELLED');
    const step = u.pathname.match(/^\/service-jobs\/(\d+)\/(send|ready|collect)$/);
    if (method === 'POST' && step) return job(step[1], step[2] === 'send' ? 'AT_BINDER' : step[2] === 'ready' ? 'READY' : 'COLLECTED');
    if (u.pathname === '/pos/transactions') {
      return json(contract(PosTransactionListResponseSchema, { items: [{ ...theSale, lineItems: undefined }], total: 1, page: 1, totalPages: 1 }));
    }
    if (u.pathname === '/pos/transactions/77') return json(theSale);
    if (method === 'POST' && u.pathname === '/returns') {
      return json(contract(ReturnSchema, {
        id: '5', returnNumber: 'RET-20261026-0001', transactionId: '77', transactionNumber: 'POS-20261026-0001', branchId: 1,
        customerId: 1, totalRefundAmount: 200, refundMethod: 'cash', status: 'completed', reason: 'Spine cracked',
        processedBy: 9, approvedBy: 9, createdAt: CREATED, orderId: null, orderNumber: null,
      }), 201);
    }
    if (u.pathname === '/notifications/stream') return new Response(new ReadableStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    if (u.pathname === '/notifications/unread-count') return json(contract(UnreadCountResponseSchema, { count: 1 }));
    if (u.pathname === '/notifications') {
      const data = [contract(NotificationSchema, {
        id: '1', branchId: 1, targetRoles: ['Sales', 'Manager', 'Admin'], targetStaffId: null, eventType: 'service_job.ready',
        title: '🧵 Binding Ready', body: 'SVC-20261026-0001 — Leather binding is ready: call Abebe Kebede', entityType: 'service_job',
        entityId: '31', severity: 'success', isRead: false, readAt: null, createdAt: new Date().toISOString(),
      })];
      return json(contract(NotificationListResponseSchema, { data, total: 1, page: 1, pageSize: 50, totalPages: 1 }));
    }
    if (u.pathname.startsWith('/notifications/')) return json(contract(MarkReadResponseSchema, { success: true }));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body as Record<string, unknown>);
const lastBoardRead = () => new URL(calls.filter((c) => c.method === 'GET' && c.path.startsWith('/service-jobs')).slice(-1)[0].path, 'http://x').searchParams;

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
  return userEvent.setup();
}

const row = async (jobNumber: string) => (await screen.findByText(jobNumber)).closest('tr') as HTMLElement;

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Sales']);
  theSale = sale('COLLECTED');
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the Binding Jobs page (1a)', () => {
  it('is under Sales, for the selling roles only', () => {
    const sales = NAV_SECTIONS.find((s) => s.id === 'sales');
    expect(sales?.items.map((i) => i.label)).toContain('Binding Jobs');
    expect(canOpenPage('binding-jobs', 'Sales', ['Sales'], ['CREATE_SALE'])).toBe(true);
    expect(canOpenPage('binding-jobs', 'Manager', ['Manager'], ['CREATE_SALE', 'MANAGE_BRANCH'])).toBe(true);
    expect(canOpenPage('binding-jobs', 'Stock_Clerk', ['Stock_Clerk'], ['MANAGE_INVENTORY'])).toBe(false);
    expect(canOpenPage('binding-jobs', 'Finance_Officer', ['Finance_Officer'], ['PROCESS_PAYMENT', 'VIEW_REPORTS'])).toBe(false);
  });

  it('lists the branch\'s jobs with the book, the binding, the customer\'s phone to call, the sale and the ready date', async () => {
    renderWith(<BindingJobsPage />);
    const first = await row('SVC-20261026-0001');
    expect(within(first).getByText('Oromay')).toBeInTheDocument();
    expect(within(first).getByText('Leather binding × 2')).toBeInTheDocument();
    expect(within(first).getByText('Abebe Kebede')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: '0911000000' })).toHaveAttribute('href', 'tel:0911000000');
    expect(within(first).getByText('POS-20261026-0001')).toBeInTheDocument();
    expect(within(first).getByText('2026-10-31')).toBeInTheDocument();
    expect(within(first).getByText('Requested')).toBeInTheDocument();

    const late = await row('SVC-20261020-0004');
    expect(within(late).getByText('Overdue')).toBeInTheDocument();
    expect(within(late).getByText('no phone')).toBeInTheDocument();
    expect(within(first).queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('filters by status, overdue and job number or customer', async () => {
    const user = renderWith(<BindingJobsPage />);
    await row('SVC-20261026-0001');
    await user.selectOptions(screen.getByLabelText('Status'), 'Ready');
    await waitFor(() => expect(lastBoardRead().get('status')).toBe('READY'));
    await user.click(screen.getByLabelText('Overdue only'));
    await waitFor(() => expect(lastBoardRead().get('overdue')).toBe('true'));
    await user.type(screen.getByPlaceholderText('Job number or customer…'), 'Abebe');
    await waitFor(() => expect(lastBoardRead().get('q')).toBe('Abebe'));
  });

  it('moves a job on by whoever sells; an order\'s ready job goes with its delivery', async () => {
    const user = renderWith(<BindingJobsPage />);
    await user.click(within(await row('SVC-20261026-0001')).getByRole('button', { name: 'Sent to binder' }));
    await waitFor(() => expect(posted('/service-jobs/31/send')).toHaveLength(1));
    await user.click(within(await row('SVC-20261020-0004')).getByRole('button', { name: 'Back and ready' }));
    await waitFor(() => expect(posted('/service-jobs/32/ready')).toHaveLength(1));
    await user.click(within(await row('SVC-20261018-0001')).getByRole('button', { name: 'Collected' }));
    await waitFor(() => expect(posted('/service-jobs/34/collect')).toHaveLength(1));

    const onOrder = await row('SVC-20261019-0002');
    expect(within(onOrder).queryByRole('button', { name: 'Collected' })).not.toBeInTheDocument();
    expect(within(onOrder).getByText('goes with the order')).toBeInTheDocument();
  });
});

describe('cancelling a binding (3a)', () => {
  it('is for a Manager or Admin, on a job still Requested, with a reason', async () => {
    me = profile(['Manager']);
    const user = renderWith(<BindingJobsPage />);
    expect(within(await row('SVC-20261020-0004')).queryByRole('button', { name: 'Cancel binding' })).not.toBeInTheDocument();
    await user.click(within(await row('SVC-20261026-0001')).getByRole('button', { name: 'Cancel binding' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel binding SVC-20261026-0001' });
    expect(dialog.textContent).toMatch(/fee goes back the way it was paid/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel binding' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('A reason is required');
    expect(posted('/service-jobs/31/cancel')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Reason'), 'Customer changed their mind');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel binding' }));
    await waitFor(() => expect(posted('/service-jobs/31/cancel')).toEqual([{ reason: 'Customer changed their mind' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is not offered to Sales', async () => {
    renderWith(<BindingJobsPage />);
    expect(within(await row('SVC-20261026-0001')).queryByRole('button', { name: 'Cancel binding' })).not.toBeInTheDocument();
  });
});

describe('a defective bound copy through Returns (4a)', () => {
  async function pickSale() {
    const user = renderWith(<ReturnsPage initialContext={{}} />);
    await settle();
    await user.type(screen.getByRole('textbox', { name: 'Transaction or order number' }), 'POS-20261026-0001');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: /Use this transaction/ }));
    await settle();
    return user;
  }

  it('says which copies are bound and returns only the unbound ones as any book', async () => {
    const user = await pickSale();
    expect(screen.getByText(/2 bound \(Collected\): they come back only defective/)).toBeInTheDocument();
    // Sales does not take a bound copy back.
    expect(screen.queryByLabelText('Defective binding')).not.toBeInTheDocument();
    expect(screen.getByText(/A Manager or Admin takes back a defective bound copy/)).toBeInTheDocument();
    const qty = screen.getByRole('spinbutton', { name: 'Quantity of Oromay to return' });
    expect(qty).toHaveAttribute('max', '1');
    await user.clear(qty);
    await user.type(qty, '1');
    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(posted('/returns')).toHaveLength(1));
    expect(posted('/returns')[0]).toEqual({ transactionId: 77, lines: [{ transactionLineItemId: 5, quantity: 1, disposition: 'SELLABLE' }] });
  });

  it('takes back a bound copy defective, by a Manager, with the reason: book and fee, kept apart as damaged', async () => {
    me = profile(['Manager']);
    const user = await pickSale();
    await user.click(screen.getByLabelText('Defective binding'));
    expect(screen.getByLabelText('Damaged')).toBeChecked();
    expect(screen.getByLabelText('Damaged')).toBeDisabled();
    const qty = screen.getByRole('spinbutton', { name: 'Quantity of Oromay to return' });
    expect(qty).toHaveAttribute('max', '2');
    await user.clear(qty);
    await user.type(qty, '1');
    // The book's 100 and its share of the fee, 100.
    expect(screen.getByText('Total Value').nextElementSibling?.textContent).toMatch(/200\.00$/);

    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    expect(await screen.findByText('Say what is wrong with the bound copy')).toBeInTheDocument();
    expect(posted('/returns')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('What is wrong with the bound copy (required)'), 'Spine cracked');
    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(posted('/returns')).toHaveLength(1));
    expect(posted('/returns')[0]).toEqual({
      transactionId: 77, reason: 'Spine cracked',
      lines: [{ transactionLineItemId: 5, quantity: 1, disposition: 'DAMAGED', defective: true }],
    });
  });

  it('offers no defective return before the bound copies are handed over', async () => {
    me = profile(['Manager']);
    theSale = sale('READY');
    await pickSale();
    expect(screen.getByText(/2 bound \(Ready\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Defective binding')).not.toBeInTheDocument();
  });

  it('treats a cancelled binding\'s copies as any book', async () => {
    theSale = sale('CANCELLED');
    await pickSale();
    expect(screen.queryByText(/bound/)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Quantity of Oromay to return' })).toHaveAttribute('max', '3');
  });
});

describe('the Ready notification (2a)', () => {
  it('opens the Binding Jobs page', async () => {
    const onNavigate = vi.fn();
    const user = renderWith(<NotificationBell onNavigate={onNavigate} />);
    await user.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await user.click(await screen.findByText('🧵 Binding Ready'));
    expect(onNavigate).toHaveBeenCalledWith('binding-jobs');
  });
});
