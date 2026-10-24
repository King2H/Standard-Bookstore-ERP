// #23 (M6, step 4): Bank accounts moves to features/bankAccounts. The page
// opens on the session branch (only staff with access to all branches pick
// another); actions follow every role held; an account can be edited (owner
// decision 1a) and deactivating is confirmed (2a); a statement line is offered
// exactly the open movements of its amount and direction, and both lists page
// (3a). Bank payments name their account only while the module is on. Every
// mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BankAccountListResponseSchema, BankAccountSchema, BankEntryListResponseSchema, BranchListResponseSchema, CurrencyResponseSchema,
  ImportStatementResponseSchema, ProfileResponseSchema, StatementLineListResponseSchema,
  type BankAccount, type BankEntry, type ProfileResponse, type StatementLine,
} from '@bms/shared';
import BankAccountsPage from '../features/bankAccounts/pages/BankAccountsPage.js';
import { useBranchBankAccounts } from '../features/bankAccounts/queries.js';
import BankAccountSelect from '../components/BankAccountSelect.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-18T07:00:00.000Z';

function profile(roles: string[], isAllBranches = false): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

function account(over: Partial<BankAccount> = {}): BankAccount {
  return contract(BankAccountSchema, {
    id: 7, branchId: 1, accountName: 'Main', bankName: 'CBE', accountNumberMasked: '****6789', ibanMasked: null,
    currency: 'ETB', isActive: true, createdAt: CREATED, hasMovements: true, ...over,
  });
}

const entry = (over: Partial<BankEntry>): BankEntry => ({
  id: '81', bankAccountId: 7, sourceType: 'pos_payment', sourceId: '5', amount: 150, direction: 'in', status: 'uncleared',
  notes: 'Sale TXN-1', createdAt: '2026-10-10T09:00:00.000Z', ...over,
});

const line = (over: Partial<StatementLine> = {}): StatementLine => ({
  id: '31', bankAccountId: 7, statementDate: '2026-10-11', amount: 150, direction: 'in', reference: 'FT9', description: null,
  entryId: null, matchedAt: null, importedAt: CREATED, ...over,
});

const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 10, totalPages: 1 });

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let me: ProfileResponse;
let accounts: BankAccount[];
let entries: BankEntry[];
let lines: StatementLine[];
let moduleOn: boolean;

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: 'USD' }));
    if (u.pathname === '/branches') {
      return json(contract(BranchListResponseSchema, page([
        { id: 1, name: 'Head Office' },
        { id: 2, name: 'Piassa' },
      ].map((b) => ({ ...b, address: 'Addis Ababa', contactInfo: {}, operatingHours: {}, isActive: true, createdAt: CREATED })))));
    }
    const m = u.pathname.match(/^\/branches\/(\d+)\/bank-accounts(?:\/(\d+))?(\/.*)?$/);
    if (m) {
      if (!moduleOn) return json({ error: 'NOT_FOUND', message: 'Not found', details: {} }, 404);
      const [, branch, , rest] = m;
      if (rest === '/entries') {
        const amount = u.searchParams.get('amount');
        const direction = u.searchParams.get('direction');
        const items = entries.filter((e) => (!amount || e.amount === Number(amount)) && (!direction || e.direction === direction));
        return json(contract(BankEntryListResponseSchema, page(items)));
      }
      if (rest === '/statement-lines' && method === 'GET') {
        const items = u.searchParams.get('matched') === 'false' ? lines.filter((l) => l.entryId === null) : lines;
        return json(contract(StatementLineListResponseSchema, page(items)));
      }
      if (rest === '/statement-lines') return json(contract(ImportStatementResponseSchema, { imported: 1, matched: 0, duplicates: 0 }), 201);
      if (method === 'GET') return json(contract(BankAccountListResponseSchema, page(accounts.filter((a) => a.branchId === Number(branch)))));
      return json(contract(BankAccountSchema, accounts[0]));
    }
    return json({ items: [] });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);
const gets = (prefix: string) => calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix)).map((c) => c.path);

/** The payment forms' account picker, beside the page in the same cache. */
function Probe() {
  const { accounts: active, required } = useBranchBankAccounts(1, true);
  return <p>{required ? `required:${active.length}` : 'not required'}</p>;
}

async function openPage(withProbe = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{withProbe && <Probe />}<BankAccountsPage /></ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  return userEvent.setup();
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Manager']);
  accounts = [account(), account({ id: 8, branchId: 2, accountName: 'Piassa Till' })];
  entries = [entry({}), entry({ id: '82', amount: 99, notes: 'Sale TXN-2' })];
  lines = [line(), line({ id: '32', reference: 'FT8', entryId: '80', matchedAt: CREATED })];
  moduleOn = true;
  stubApi();
});

afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

describe('the branch', () => {
  it('is the session\'s for staff of one branch, with no picker (was: every branch offered, the others refused)', async () => {
    await openPage();
    expect(await rowOf('Main')).toBeInTheDocument();
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument();
    expect(gets('/branches/').every((p) => p.startsWith('/branches/1/'))).toBe(true);
  });

  it('can be picked by staff with access to all branches, starting on the session\'s', async () => {
    me = profile(['Admin'], true);
    const user = await openPage();
    await rowOf('Main');
    const picker = screen.getByLabelText('Branch') as HTMLSelectElement;
    expect(picker.value).toBe('1');
    await user.selectOptions(picker, '2');
    expect(await rowOf('Piassa Till')).toBeInTheDocument();
  });

  it('says so when the module is switched off', async () => {
    moduleOn = false;
    await openPage();
    expect(await screen.findByText('The Bank Accounts module is switched off.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Account/ })).not.toBeInTheDocument();
  });
});

describe('accounts', () => {
  it('are managed by any role held (was: the main role, so a Finance_Officer who is also Manager could not)', async () => {
    me = profile(['Finance_Officer', 'Manager']);
    await openPage();
    const row = await rowOf('Main');
    expect(screen.getByRole('button', { name: /New Account/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('are only read by a Finance_Officer, who still reconciles', async () => {
    me = profile(['Finance_Officer']);
    const user = await openPage();
    const row = await rowOf('Main');
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Account/ })).not.toBeInTheDocument();
    await user.click(row);
    expect(await screen.findByLabelText(/Import statement lines/)).toBeInTheDocument();
  });

  it('are opened with the API\'s rules checked before sending (was: number and IBAN unchecked)', async () => {
    const user = await openPage();
    await user.click(await screen.findByRole('button', { name: /New Account/ }));
    const dialog = screen.getByRole('dialog', { name: 'New Bank Account' });
    await user.type(within(dialog).getByLabelText('Account Name *'), 'Savings');
    await user.type(within(dialog).getByLabelText('Bank Name *'), 'Awash');
    await user.type(within(dialog).getByLabelText('Account Number *'), 'AC#12345');
    await user.type(within(dialog).getByLabelText('IBAN (optional)'), 'ET1');
    await user.click(within(dialog).getByRole('button', { name: 'Create Account' }));
    expect(await within(dialog).findByText('Letters and digits, with spaces or dashes between groups')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('alert')).toHaveLength(2);
    expect(sent('POST', '/branches/1/bank-accounts')).toEqual([]);

    await user.clear(within(dialog).getByLabelText('Account Number *'));
    await user.type(within(dialog).getByLabelText('Account Number *'), '1000 2000 3000');
    await user.clear(within(dialog).getByLabelText('IBAN (optional)'));
    await user.click(within(dialog).getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(sent('POST', '/branches/1/bank-accounts')).toEqual([
      { accountName: 'Savings', bankName: 'Awash', accountNumber: '1000 2000 3000' },
    ]));
  });

  it("are opened in the shop's currency, sending none (#181; was: \"Accounts are in ETB\")", async () => {
    const user = await openPage();
    await user.click(await screen.findByRole('button', { name: /New Account/ }));
    const dialog = screen.getByRole('dialog', { name: 'New Bank Account' });
    expect(await within(dialog).findByText("Accounts are in the shop's currency, USD.")).toBeInTheDocument();
  });

  it('are edited: the names always, the number only while no money has moved (decision 1a)', async () => {
    const user = await openPage();
    await user.click(within(await rowOf('Main')).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Main' });
    expect(within(dialog).getByLabelText(/Account Number/)).toBeDisabled();
    const name = within(dialog).getByLabelText('Account Name *');
    await user.clear(name);
    await user.type(name, 'Main Operations');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/branches/1/bank-accounts/7')).toEqual([{ accountName: 'Main Operations', bankName: 'CBE' }]));
  });

  it('change their number on an edit while no money has moved', async () => {
    accounts = [account({ hasMovements: false })];
    const user = await openPage();
    await user.click(within(await rowOf('Main')).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Main' });
    await user.type(within(dialog).getByLabelText(/Account Number/), '5555 6666');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/branches/1/bank-accounts/7')).toEqual([{ accountName: 'Main', bankName: 'CBE', accountNumber: '5555 6666' }]));
  });

  it('are deactivated only once confirmed, and the payment forms\' picker is refreshed (decision 2a; was: one click, picker stale)', async () => {
    const user = await openPage(true);
    expect(await screen.findByText('required:1')).toBeInTheDocument();
    const before = gets('/branches/1/bank-accounts?isActive=true').length;
    await user.click(within(await rowOf('Main')).getByRole('button', { name: 'Deactivate' }));
    expect(sent('POST', '/branches/1/bank-accounts/7/deactivate')).toEqual([]);
    const dialog = screen.getByRole('dialog', { name: 'Deactivate Bank Account' });
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(sent('POST', '/branches/1/bank-accounts/7/deactivate')).toHaveLength(1));
    await waitFor(() => expect(gets('/branches/1/bank-accounts?isActive=true').length).toBeGreaterThan(before));
  });
});

describe('reconciliation', () => {
  const openAccount = async () => {
    const user = await openPage();
    await user.click(await rowOf('Main'));
    await screen.findByText('FT9');
    return user;
  };

  it('lists unmatched statement lines first, all on request', async () => {
    const user = await openAccount();
    expect(screen.queryByText('FT8')).not.toBeInTheDocument();
    expect(gets('/branches/1/bank-accounts/7/statement-lines').some((p) => p.includes('matched=false'))).toBe(true);
    await user.selectOptions(screen.getByLabelText('Statement lines to show'), 'all');
    expect(await screen.findByText('FT8')).toBeInTheDocument();
  });

  it('names a bad statement line instead of sending the import (was: the whole import refused)', async () => {
    const user = await openAccount();
    const box = screen.getByLabelText(/Import statement lines/);
    await user.type(box, '2026-10-11, 1500.005, in, FT1');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Line 1: amount: At most two decimals');

    await user.clear(box);
    await user.type(box, '2026-10-11, 15, in{enter}2026-02-31, 10, out');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Line 2: statementDate: Not a calendar date');
    expect(sent('POST', '/branches/1/bank-accounts/7/statement-lines')).toEqual([]);

    await user.clear(box);
    await user.type(box, '2026-10-11, 1500.00, in, FT1, From customer, branch 2{enter}{enter}2026-10-12, 20, out');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(sent('POST', '/branches/1/bank-accounts/7/statement-lines')).toEqual([{ lines: [
      { statementDate: '2026-10-11', amount: '1500.00', direction: 'in', reference: 'FT1', description: 'From customer, branch 2' },
      { statementDate: '2026-10-12', amount: '20', direction: 'out' },
    ] }]));
  });

  it('offers a line exactly the open movements of its amount and direction, asked of the API (decision 3a)', async () => {
    const user = await openAccount();
    const row = (await screen.findByText('FT9')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Match' }));
    const select = await within(row).findByRole('combobox', { name: 'Movement to match' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a movement…', expect.stringContaining('Sale TXN-1')]);
    expect(gets('/branches/1/bank-accounts/7/entries').some((p) => p.includes('amount=150.00') && p.includes('direction=in') && p.includes('status=uncleared'))).toBe(true);

    await user.selectOptions(select, '81');
    await waitFor(() => expect(sent('POST', '/branches/1/bank-accounts/7/statement-lines/31/match')).toEqual([{ entryId: '81' }]));
  });
});

describe('bank accounts for a bank payment', () => {
  it('needs no account while the module is off (was: a bank payment could not be made)', async () => {
    moduleOn = false;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    expect(await screen.findByText('not required')).toBeInTheDocument();
  });

  it('asks for one while it is on', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    expect(await screen.findByText('required:1')).toBeInTheDocument();
  });

  it('shows the masked number (was: "undefined")', () => {
    render(<BankAccountSelect accounts={[account()]} value={null} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'CBE — Main (****6789)' })).toBeInTheDocument();
  });
});
