// Returns (#21): the refund goes back the way the sale was paid, so the page
// offers no refund method, and a return can no longer be rejected.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReturnsPage from '../pages/ReturnsPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
  getCurrentBranchId: () => 1,
}));

const sale = {
  id: '41', transactionNumber: 'POS-20261010-0001', grandTotal: 29, amountPaid: 29, status: 'completed',
  paymentStatus: 'paid', createdAt: new Date().toISOString(),
  lineItems: [{ id: '7', bookId: 1, bookTitle: 'Fikir Eske Mekabir', bookIsbn: '1', quantity: 3, unitPrice: 10, discountPct: 0, lineTotal: 29 }],
};

const ret = {
  id: '5', returnNumber: 'RET-20261010-0001', transactionId: '41', totalRefundAmount: 29, refundMethod: 'mixed',
  status: 'completed', reason: null, createdAt: new Date().toISOString(),
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReturnsPage userRole="Manager" userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/pos/transactions?')) return Promise.resolve({ items: [sale] });
    if (path === '/pos/transactions/41') return Promise.resolve(sale);
    if (path.startsWith('/returns?')) return Promise.resolve({ items: [ret], total: 1, page: 1, totalPages: 1 });
    if (path === '/returns/5') {
      return Promise.resolve({
        ...ret,
        lineItems: [{ id: '1', bookTitle: 'Fikir Eske Mekabir', quantity: 3, unitPrice: 10, lineRefundAmount: 29 }],
        refunds: [{ id: '1', method: 'credit_note', amount: 20 }, { id: '2', method: 'mobile', amount: 9 }],
      });
    }
    return Promise.resolve({ items: [] });
  });
  postMock.mockResolvedValue(ret);
});

describe('ReturnsPage', () => {
  it('sends no refund method and values lines from what they cost after discount', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText(/transaction number/i), 'POS-20261010-0001');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: /Use this transaction/ }));

    expect(screen.queryByRole('button', { name: /Store Credit/ })).not.toBeInTheDocument();
    const qty = screen.getByRole('spinbutton');
    await user.clear(qty);
    await user.type(qty, '3');
    expect(screen.getAllByText(/29\.00/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Process Return' }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [path, body] = postMock.mock.calls[0];
    expect(path).toBe('/returns');
    expect(body).toEqual({ transactionId: 41, reason: undefined, lines: [{ transactionLineItemId: 7, quantity: 3 }] });
  });

  it('lists returns without a Reject action and shows how each was refunded', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Returns History/ }));
    await user.click(await screen.findByText('RET-20261010-0001'));

    expect(screen.getByText('Mixed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(await screen.findByText(/Credit Note: .*20\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Telebirr: .*9\.00/)).toBeInTheDocument();
  });
});
