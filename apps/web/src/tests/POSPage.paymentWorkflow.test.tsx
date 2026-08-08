// Single Authoritative Payment Collection Workflow — Sales History no longer
// collects payment directly (POST /pos/transactions/:id/payment must not be
// reachable from here); "View Payments" navigates to the Payments module.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import POSPage from '../pages/POSPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: (...args: unknown[]) => postMock(...args) },
  getCurrentBranchId: () => 1,
}));

function makeHistoryPage() {
  return {
    items: [{
      id: 'tx-1', transactionNumber: 'TXN-0001', subtotal: 10, discountTotal: 0, grandTotal: 10,
      amountPaid: 0, amountDue: 10, paymentStatus: 'unpaid', currency: 'ETB', status: 'completed',
      createdAt: new Date().toISOString(),
    }],
    total: 1, page: 1, totalPages: 1,
  };
}

function renderPOSPage(onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { onNavigate, ...render(
    <QueryClientProvider client={qc}>
      <POSPage userRole="Sales" userPermissions={[]} onNavigate={onNavigate} />
    </QueryClientProvider>,
  ) };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/pos/transactions?')) return Promise.resolve(makeHistoryPage());
    return Promise.resolve({ items: [] });
  });
});

describe('Sales History — no direct Collect, View Payments navigates', () => {
  it('has no Collect action, only View Payments, for an unpaid transaction', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPOSPage();

    await user.click(screen.getByRole('button', { name: /Sales History/i }));
    await waitFor(() => expect(screen.getByText('TXN-0001')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /^Collect$/i })).not.toBeInTheDocument();
    const viewBtn = screen.getByRole('button', { name: /View Payments/i });
    expect(viewBtn).toBeInTheDocument();

    await user.click(viewBtn);
    expect(onNavigate).toHaveBeenCalledWith('payments', { tab: 'history', orderId: 'tx-1', sourceType: 'pos' });
    // No payment transaction can be created directly from Sales History.
    expect(postMock).not.toHaveBeenCalledWith(expect.stringContaining('/payment'), expect.anything());
  });
});
