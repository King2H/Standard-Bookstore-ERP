// Single Authoritative Payment Collection Workflow — Sales History no longer
// collects payment directly (POST /pos/transactions/:id/payment must not be
// reachable from here); "View Payments" navigates to the Payments module's
// Collect tab, and is only offered for credit sales with an outstanding
// balance (paymentStatus 'partial' or 'credit' — pos.service.ts never
// produces any other non-'paid' value).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    items: [
      {
        id: 'tx-1', transactionNumber: 'TXN-0001', subtotal: 10, discountTotal: 0, grandTotal: 10,
        amountPaid: 0, amountDue: 10, paymentStatus: 'credit', currency: 'ETB', status: 'completed',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tx-2', transactionNumber: 'TXN-0002', subtotal: 20, discountTotal: 0, grandTotal: 20,
        amountPaid: 10, amountDue: 10, paymentStatus: 'partial', currency: 'ETB', status: 'completed',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'tx-3', transactionNumber: 'TXN-0003', subtotal: 30, discountTotal: 0, grandTotal: 30,
        amountPaid: 30, amountDue: 0, paymentStatus: 'paid', currency: 'ETB', status: 'completed',
        createdAt: new Date().toISOString(),
      },
    ],
    total: 3, page: 1, totalPages: 1,
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

describe('Sales History — no direct Collect, View Payments navigates to Collect', () => {
  it('has no Collect action, only View Payments, for a credit (unpaid) transaction', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderPOSPage();

    await user.click(screen.getByRole('button', { name: /Sales History/i }));
    await waitFor(() => expect(screen.getByText('TXN-0001')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /^Collect$/i })).not.toBeInTheDocument();
    const row = screen.getByText('TXN-0001').closest('tr') as HTMLElement;
    const viewBtn = within(row).getByRole('button', { name: /View Payments/i });
    expect(viewBtn).toBeInTheDocument();

    await user.click(viewBtn);
    // No `tab` param — lands on Payments' Collect tab (pre-selected for this
    // transaction), not Payment History.
    expect(onNavigate).toHaveBeenCalledWith('payments', { orderId: 'tx-1', sourceType: 'pos' });
    // No payment transaction can be created directly from Sales History.
    expect(postMock).not.toHaveBeenCalledWith(expect.stringContaining('/payment'), expect.anything());
  });

  it('also shows View Payments for a partially-paid transaction', async () => {
    const user = userEvent.setup();
    renderPOSPage();

    await user.click(screen.getByRole('button', { name: /Sales History/i }));
    await waitFor(() => expect(screen.getByText('TXN-0002')).toBeInTheDocument());

    const row = screen.getByText('TXN-0002').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: /View Payments/i })).toBeInTheDocument();
  });

  it('hides View Payments for a fully-paid transaction — nothing left to collect', async () => {
    const user = userEvent.setup();
    renderPOSPage();

    await user.click(screen.getByRole('button', { name: /Sales History/i }));
    await waitFor(() => expect(screen.getByText('TXN-0003')).toBeInTheDocument());

    const row = screen.getByText('TXN-0003').closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /View Payments/i })).not.toBeInTheDocument();
  });
});
