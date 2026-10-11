// #21 bank accounts: bank payments name their account only while the module is
// on; account numbers show masked (was "undefined"); statement lines are
// matched to the system's open movements.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BankAccountsPage, { parseStatement } from '../pages/BankAccountsPage.js';
import BankAccountSelect from '../components/BankAccountSelect.js';
import { useBranchBankAccounts } from '../features/bankAccounts/queries.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
  getAccessToken: () => 'token',
  getCurrentBranchId: () => 1,
}));

const account = { id: 7, branchId: 1, accountName: 'Main', bankName: 'CBE', accountNumberMasked: '****6789', ibanMasked: null, currency: 'ETB', isActive: true, createdAt: '2026-10-01T00:00:00Z', hasMovements: true };

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function Probe() {
  const { accounts, required } = useBranchBankAccounts(1, true);
  return <p>{required ? `required:${accounts.length}` : 'not required'}</p>;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue({});
});

describe('bank accounts for a bank payment', () => {
  it('needs no account while the module is off (was: a bank payment could not be made)', async () => {
    getMock.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND' }));
    wrap(<Probe />);
    expect(await screen.findByText('not required')).toBeInTheDocument();
  });

  it('asks for one while it is on', async () => {
    getMock.mockResolvedValue({ items: [account] });
    wrap(<Probe />);
    expect(await screen.findByText('required:1')).toBeInTheDocument();
  });

  it('shows the masked number (was: "undefined")', () => {
    render(<BankAccountSelect accounts={[account]} value={null} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'CBE — Main (****6789)' })).toBeInTheDocument();
  });
});

describe('statement import', () => {
  it('reads date, amount, direction, reference and description', () => {
    expect(parseStatement('2026-10-11, 1500.00, in, FT1, From customer\n\n2026-10-12, 20, out')).toEqual([
      { statementDate: '2026-10-11', amount: 1500, direction: 'in', reference: 'FT1', description: 'From customer' },
      { statementDate: '2026-10-12', amount: 20, direction: 'out' },
    ]);
    expect(() => parseStatement('11/10/2026, 15, in')).toThrow(/Cannot read/);
  });
});

describe('reconciliation', () => {
  it('matches an open statement line to an open movement of the same amount and direction', async () => {
    getMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve({ items: [{ id: 1, name: 'Head Office', isActive: true }] });
      if (path.startsWith('/branches/1/bank-accounts/7/statement-lines')) {
        return Promise.resolve({ items: [{ id: '31', statementDate: '2026-10-11', amount: 150, direction: 'in', reference: 'FT9', description: null, entryId: null }] });
      }
      if (path.startsWith('/branches/1/bank-accounts/7/entries')) {
        return Promise.resolve({ items: [
          { id: '81', sourceType: 'pos_payment', amount: 150, direction: 'in', status: 'uncleared', notes: 'Sale TXN-1', createdAt: '2026-10-10T09:00:00Z' },
          { id: '82', sourceType: 'pos_payment', amount: 99, direction: 'in', status: 'uncleared', notes: 'Sale TXN-2', createdAt: '2026-10-10T09:00:00Z' },
        ] });
      }
      if (path.startsWith('/branches/1/bank-accounts')) return Promise.resolve({ items: [account], total: 1 });
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    wrap(<BankAccountsPage userRole="Finance_Officer" />);

    await screen.findByRole('option', { name: 'Head Office' });
    await user.selectOptions(screen.getByRole('combobox'), '1');
    await user.click(await screen.findByText('Main'));
    const line = (await screen.findByText('FT9')).closest('tr')!;
    await user.click(within(line).getByRole('button', { name: 'Match' }));

    const select = within(line).getByRole('combobox', { name: 'Movement to match' });
    // Only the movement that fits is offered.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a movement…', expect.stringContaining('Sale TXN-1')]);
    await user.selectOptions(select, '81');

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/branches/1/bank-accounts/7/statement-lines/31/match', { entryId: '81' }));
  });
});
