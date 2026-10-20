// #23 (M6, step 4): Receivables moves to features/receivables. Actions follow
// every role held; the totals are for the roles that read reports (owner
// decision 1a); writing off and a new due date are asked in the app's dialogs
// (2a); "Overdue only" goes, as the Overdue status does the same (3a). Every
// mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ProfileResponseSchema, ReceivableListResponseSchema, ReceivableSchema, ReceivableSummarySchema,
  type ProfileResponse, type Receivable,
} from '@bms/shared';
import ReceivablesPage from '../features/receivables/pages/ReceivablesPage.js';
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

function receivable(over: Partial<Receivable> = {}): Receivable {
  return contract(ReceivableSchema, {
    id: '21', sourceType: 'pos_credit_sale', sourceRefId: 'POS-20261018-0004', sourceEntityId: '71', customerId: 5,
    customerName: 'Abebe Kebede', customerCode: 'CUS-0005', branchId: 1, originalAmount: 100, outstandingAmount: 60,
    currency: 'ETB', dueDate: '2026-11-05', settlementDate: null, status: 'PartiallyPaid', notes: null,
    writtenOffAmount: null, writtenOffAt: null, writtenOffBy: null, writeOffReason: null, cancelledAmount: null,
    cancelledAt: null, createdAt: CREATED, updatedAt: CREATED, ...over,
  });
}

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let rows: Receivable[];

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/receivables/summary') {
      // The API's rule: VIEW_REPORTS.
      if (!me.currentRoles.some((r) => ['Admin', 'Manager', 'Finance_Officer'].includes(r))) {
        return json({ error: 'FORBIDDEN', message: 'Forbidden', details: {} }, 403);
      }
      return json(contract(ReceivableSummarySchema, {
        totalOutstanding: 1234.5, pendingCount: 2, overdueCount: 1, partiallyPaidCount: 3, settledThisMonth: 4, writtenOffThisMonth: 0,
      }));
    }
    if (u.pathname === '/receivables' && method === 'GET') {
      return json(contract(ReceivableListResponseSchema, { items: rows, total: rows.length, page: 1, totalPages: 1 }));
    }
    if (method === 'POST' || method === 'PATCH') return json(contract(ReceivableSchema, rows[0]));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
const lists = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/receivables?')).map((c) => c.path);

async function openPage(initialContext: Record<string, string> = {}, onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><ReceivablesPage initialContext={initialContext} onNavigate={onNavigate} /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  return { user: userEvent.setup(), onNavigate };
}

const rowOf = async (ref: string) => (await screen.findByText(ref)).closest('tr') as HTMLElement;

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Manager']);
  rows = [receivable()];
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the list', () => {
  it('leaves the branch to the session, and opens on the Dashboard\'s status', async () => {
    await openPage({ status: 'Pending,PartiallyPaid,Overdue', branchId: '3' });
    await rowOf('POS-20261018-0004');
    expect(lists().length).toBeGreaterThan(0);
    expect(lists().every((p) => !p.includes('branchId'))).toBe(true);
    expect(lists()[0]).toContain('status=Pending%2CPartiallyPaid%2COverdue');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('Pending,PartiallyPaid,Overdue');
  });

  it('has no "Overdue only" box: the Overdue status does the same (decision 3a)', async () => {
    const { user } = await openPage();
    await rowOf('POS-20261018-0004');
    expect(screen.queryByLabelText(/Overdue only/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'Overdue');
    await waitFor(() => expect(lists().some((p) => p.includes('status=Overdue') && !p.includes('overdueOnly'))).toBe(true));
  });

  it('shows a written-off receivable as such, with no actions', async () => {
    rows = [receivable({ status: 'WrittenOff', outstandingAmount: 0, writtenOffAmount: 60, writtenOffAt: CREATED, writtenOffBy: 9, writeOffReason: 'Moved away' })];
    await openPage();
    const row = await rowOf('POS-20261018-0004');
    expect(within(row).getByText('Written off')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('due dates in the reader\'s day', () => {
  const tz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  afterAll(() => { process.env.TZ = tz; });

  it('shows the due day itself west of UTC (was: the day before)', async () => {
    await openPage();
    const row = await rowOf('POS-20261018-0004');
    expect(within(row).getByText('Nov 5, 2026')).toBeInTheDocument();
  });
});

describe('totals', () => {
  it('are shown, for the session branch, to the roles that read reports', async () => {
    await openPage();
    expect(await screen.findByText('ETB 1,234.50')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith('/receivables/summary')).map((c) => c.path)).toEqual(['/receivables/summary?branchId=1']);
  });

  it('are not shown to Sales, who may not read them (decision 1a; was: six cards of "—" after a refused request)', async () => {
    me = profile(['Sales']);
    await openPage();
    await rowOf('POS-20261018-0004');
    expect(screen.queryByText('Total Outstanding')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/receivables/summary'))).toBe(false);
  });
});

describe('actions', () => {
  it('follow every role held (was: the main role, so Sales + Manager could not write off)', async () => {
    me = profile(['Sales', 'Manager']);
    await openPage();
    const row = await rowOf('POS-20261018-0004');
    expect(within(row).getByRole('button', { name: /Write Off/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Set due date' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Open in Payments/ })).toBeInTheDocument();
  });

  it('give staff who only take payments Open in Payments alone', async () => {
    me = profile(['Sales']);
    await openPage();
    const row = await rowOf('POS-20261018-0004');
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['↗ Open in Payments']);
  });

  it('open Payments on the order, POS sale or receivable that Payments collects', async () => {
    rows = [
      receivable(),
      receivable({ id: '22', sourceType: 'order_credit_sale', sourceRefId: 'ORD-20261018-0002', sourceEntityId: '171' }),
      receivable({ id: '23', sourceType: 'exchange_difference', sourceRefId: 'EXC-20261018-0003', sourceEntityId: '36' }),
    ];
    const { user, onNavigate } = await openPage();
    for (const ref of ['POS-20261018-0004', 'ORD-20261018-0002', 'EXC-20261018-0003']) {
      await user.click(within(await rowOf(ref)).getByRole('button', { name: /Open in Payments/ }));
    }
    expect(onNavigate.mock.calls).toEqual([
      ['payments', { orderId: '71', sourceType: 'pos' }],
      ['payments', { orderId: '171', sourceType: 'order' }],
      ['payments', { orderId: '23', sourceType: 'exchange_difference' }],
    ]);
  });

  it('write off with a reason asked in the app\'s dialog, within the API\'s limit (decision 2a)', async () => {
    const { user } = await openPage();
    await user.click(within(await rowOf('POS-20261018-0004')).getByRole('button', { name: /Write Off/ }));
    const dialog = screen.getByRole('dialog', { name: 'Write Off Receivable' });
    await user.click(within(dialog).getByRole('button', { name: 'Write Off' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();

    const reason = within(dialog).getByLabelText(/Why is this being written off/);
    await user.click(reason);
    await user.paste('x'.repeat(1001));
    await user.click(within(dialog).getByRole('button', { name: 'Write Off' }));
    expect(await within(dialog).findByText('At most 1000 characters')).toBeInTheDocument();
    expect(sent('POST', '/receivables/21/write-off')).toEqual([]);

    await user.clear(reason);
    await user.type(reason, 'Customer moved away');
    await user.click(within(dialog).getByRole('button', { name: 'Write Off' }));
    await waitFor(() => expect(sent('POST', '/receivables/21/write-off')).toEqual([{ reason: 'Customer moved away' }]));
  });

  it('change a due date in a dialog, removing it only on purpose (decision 2a; was: an empty field removed it)', async () => {
    const { user } = await openPage();
    await user.click(within(await rowOf('POS-20261018-0004')).getByRole('button', { name: 'Set due date' }));
    let dialog = screen.getByRole('dialog', { name: /Due Date of POS-20261018-0004/ });
    const day = within(dialog).getByLabelText('Due on') as HTMLInputElement;
    expect(day.value).toBe('2026-11-05');

    await user.clear(day);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Pick a date, or remove the due date')).toBeInTheDocument();
    expect(sent('PATCH', '/receivables/21/due-date')).toEqual([]);

    await user.type(day, '2026-11-30');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/receivables/21/due-date')).toEqual([{ dueDate: '2026-11-30' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(await rowOf('POS-20261018-0004')).getByRole('button', { name: 'Set due date' }));
    dialog = screen.getByRole('dialog', { name: /Due Date of/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove due date' }));
    await waitFor(() => expect(sent('PATCH', '/receivables/21/due-date')).toEqual([{ dueDate: '2026-11-30' }, { dueDate: null }]));
  });
});
