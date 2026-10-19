// Bank and Telebirr payments carry their proof (owner decisions 1a, 2a, 3a):
// the customer's bank and the transfer reference, or the Telebirr transaction
// number, typed at the counter and checked before sending. Orders, Payments and
// Exchanges are covered in their own feature tests.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../components/Toast.js';
import POSPage from '../features/pos/pages/PosPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: { get: (...args: unknown[]) => getMock(...args), post: (...args: unknown[]) => postMock(...args), patch: vi.fn() },
  getCurrentBranchId: () => 1,
}));

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('POS: a bank payment names the bank and the reference', () => {
  beforeEach(() => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/branches/1/locations')) return Promise.resolve({ items: [{ id: 7, name: 'Main', isDefaultFulfillment: true }] });
      if (path.startsWith('/books/with-availability')) {
        return Promise.resolve({ items: [{ id: 5, title: 'Fikir Eske Mekabir', isbn: '9789994400001', defaultPrice: 10, branchPrice: null }] });
      }
      // Bank Accounts off: no account to pick.
      if (path.includes('/bank-accounts')) return Promise.reject(new Error('Not found'));
      return Promise.resolve({ items: [] });
    });
    postMock.mockResolvedValue({
      id: 'tx-9', transactionNumber: 'POS-20261018-0001', subtotal: 10, discountTotal: 0, grandTotal: 10,
      amountPaid: 10, amountDue: 0, paymentStatus: 'paid', currency: 'ETB', status: 'completed', createdAt: new Date().toISOString(),
      lineItems: [], payments: [{ method: 'bank', amount: 10, payerBank: 'Awash Bank', reference: 'FT24001' }],
    });
  });

  it('refuses to add the payment until both are typed, then sends them and shows them on the receipt (was: sent with neither)', async () => {
    const user = userEvent.setup();
    renderWith(<POSPage userRole="Sales" userPermissions={['CREATE_SALE']} />);

    await user.type(screen.getByPlaceholderText('Title, ISBN, Author…'), 'Fikir');
    await user.click(await screen.findByText('Fikir Eske Mekabir'));
    await user.click(screen.getByRole('button', { name: /Bank Transfer/ }));

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter the bank the customer paid from')).toBeInTheDocument();
    await user.type(screen.getByLabelText("Customer's bank"), 'Awash Bank');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter the bank transfer reference')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Complete Sale/ })).toBeDisabled();

    await user.type(screen.getByLabelText('Transfer reference'), 'FT24001');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('· Awash Bank · FT24001')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [path, body] = postMock.mock.calls[0];
    expect(path).toBe('/pos/transactions');
    expect(body.payments).toEqual([{ method: 'bank', amount: 10, payerBank: 'Awash Bank', reference: 'FT24001' }]);
    expect(await screen.findByText('Awash Bank · FT24001')).toBeInTheDocument();
  });

  it('asks a Telebirr payment for its transaction number only', async () => {
    const user = userEvent.setup();
    renderWith(<POSPage userRole="Sales" userPermissions={['CREATE_SALE']} />);

    await user.type(screen.getByPlaceholderText('Title, ISBN, Author…'), 'Fikir');
    await user.click(await screen.findByText('Fikir Eske Mekabir'));
    await user.click(screen.getByRole('button', { name: /Telebirr/ }));
    expect(screen.queryByLabelText("Customer's bank")).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter the Telebirr transaction number')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Telebirr transaction number'), 'TB-77');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: /Complete Sale/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1].payments).toEqual([{ method: 'mobile', amount: 10, reference: 'TB-77' }]);
  });
});
