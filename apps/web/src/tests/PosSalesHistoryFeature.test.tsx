// #23 (M6, step 4): POS part 1. The page shell and Sales History move to
// features/pos. Void is offered as the API allows it (Manager or Admin, any
// role held in the branch), asked in the app's own dialog (owner decision 1a),
// and the list leaves the branch to the session. Every mocked answer is
// checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  PosTransactionListResponseSchema, PosTransactionSchema, ProfileResponseSchema,
  type PosTransaction, type ProfileResponse,
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

function sale(over: Partial<PosTransaction> = {}): PosTransaction {
  return contract(PosTransactionSchema, {
    id: '77', branchId: 1, locationId: 7, customerId: null, customerName: null, staffId: 9, cashierName: 'Sara Tesfaye', transactionNumber: 'POS-20261018-0001',
    subtotal: 10, discountTotal: 0, taxTotal: 0, grandTotal: 10, amountPaid: 10, amountDue: 0, paymentStatus: 'paid',
    currency: 'ETB', status: 'completed', createdAt: CREATED, dueDate: null, voidable: true,
    ...over,
  });
}

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
/** The list holds one voided credit sale (#240). */
let voidedList = false;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/pos/transactions') {
      const listed = voidedList
        ? sale({ status: 'voided', voidable: false, paymentStatus: 'partial', amountPaid: 1, amountDue: 0, dueDate: null })
        : sale();
      return json(contract(PosTransactionListResponseSchema, { items: [listed], total: 1, page: 1, totalPages: 1 }));
    }
    if (method === 'POST' && u.pathname === '/pos/transactions/77/void') return json(contract(PosTransactionSchema, sale({ status: 'voided', voidable: false })));
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function openHistory(userRole: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider><PosPage userRole={userRole} userPermissions={[]} initialContext={{ dateFrom: '2026-10-18' }} /></ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('POS-20261018-0001');
  await settle();
  return screen.getByText('POS-20261018-0001').closest('tr') as HTMLElement;
}

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  voidedList = false;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('Sales History: void', () => {
  it('is not offered to a Super_Admin, whom the API refuses (was: offered)', async () => {
    me = profile(['Super_Admin']);
    const row = await openHistory('Super_Admin');
    expect(within(row).queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it('is offered to a Manager by any role held in the branch (was: only by the main role)', async () => {
    me = profile(['Sales', 'Manager']);
    const row = await openHistory('Sales');
    expect(within(row).getByRole('button', { name: 'Void' })).toBeInTheDocument();
  });

  it("is asked in the app's dialog, then sent (was: the browser's confirm box)", async () => {
    me = profile(['Manager']);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const row = await openHistory('Manager');
    const user = userEvent.setup();

    await user.click(within(row).getByRole('button', { name: 'Void' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Void POS-20261018-0001\?/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // Why it is voided, kept in the audit log (#240, P11; was: not asked).
    await user.click(within(dialog).getByRole('button', { name: 'Void Sale' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByRole('textbox'), 'Rang up the wrong book');
    await user.click(within(dialog).getByRole('button', { name: 'Void Sale' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/pos/transactions/77/void', body: { reason: 'Rang up the wrong book' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });
});

describe('Sales History: the list', () => {
  it('leaves the branch to the session (was: sent the branch from the client)', async () => {
    me = profile(['Sales']);
    await openHistory('Sales');
    const list = calls.find((c) => c.path.startsWith('/pos/transactions?'));
    expect(list?.path).toContain('dateFrom=2026-10-18');
    expect(list?.path).not.toContain('branchId');
  });
});

describe('Sales History: a voided sale (#240, P9)', () => {
  it('shows no payment state or amount due: its debt was cancelled and its money handed back (was: "partial", due)', async () => {
    me = profile(['Sales']);
    voidedList = true;
    const row = await openHistory('Sales');
    expect(row).toHaveTextContent('voided');
    expect(row).not.toHaveTextContent('partial');
    expect(row).not.toHaveTextContent('Due:');
  });
});

describe('Sales History: who bought and who sold (#236, P10)', () => {
  it('names the customer, a walk-in as such, and the cashier (was: neither)', async () => {
    me = profile(['Sales']);
    const row = await openHistory('Sales');
    expect(screen.getByRole('columnheader', { name: 'Customer' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cashier' })).toBeInTheDocument();
    expect(within(row).getByText('Walk-in')).toBeInTheDocument();
    expect(within(row).getByText('Sara Tesfaye')).toBeInTheDocument();
  });

  it('finds sales by customer, phone or number', async () => {
    me = profile(['Sales']);
    await openHistory('Sales');
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search sales' }), '0911');
    await waitFor(() => expect(calls.some((c) => c.path.startsWith('/pos/transactions?') && c.path.includes('q=0911'))).toBe(true));
  });
});

describe('Sales History: one sale (#230, M5)', () => {
  it('opens on the sale a payment belongs to, from Payment History', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider><PosPage userRole="Manager" userPermissions={[]} initialContext={{ transactionNumber: 'POS-20261018-0001' }} /></ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('POS-20261018-0001')).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/pos/transactions?') && c.path.includes('transactionNumber=POS-20261018-0001'))).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show all sales' }));
    await settle();
    expect(calls.filter((c) => c.path.startsWith('/pos/transactions?')).pop()?.path).not.toContain('transactionNumber');
  });
});
