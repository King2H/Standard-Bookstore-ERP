// Single Authoritative Payment Collection Workflow — Receivables no longer
// collects payment directly (no Collect modal, POST /receivables/:id/collect
// must not be reachable from here); "Open in Payments" navigates to the
// Payments module, routed correctly per source type.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReceivablesPage from '../pages/ReceivablesPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: () => Promise.resolve({}),
  },
  getCurrentBranchId: () => 1,
}));

function makeReceivablesPage() {
  return {
    items: [
      {
        id: 'rec-pos-1', sourceType: 'pos_credit_sale', sourceRefId: 'TXN-0001', sourceEntityId: '501',
        customerId: 1, customerName: 'Alice', customerCode: 'CUST-1', branchId: 1,
        originalAmount: 100, outstandingAmount: 100, currency: 'ETB', dueDate: null, settlementDate: null,
        status: 'Pending', notes: null, createdAt: new Date().toISOString(),
      },
      {
        id: 'rec-exc-1', sourceType: 'exchange_difference', sourceRefId: 'EXC-00000001-0001', sourceEntityId: '77',
        customerId: 2, customerName: 'Bob', customerCode: 'CUST-2', branchId: 1,
        originalAmount: 50, outstandingAmount: 30, currency: 'ETB', dueDate: null, settlementDate: null,
        status: 'PartiallyPaid', notes: null, createdAt: new Date().toISOString(),
      },
    ],
    total: 2, page: 1, totalPages: 1,
  };
}

function renderReceivablesPage(onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { onNavigate, ...render(
    <QueryClientProvider client={qc}>
      <ReceivablesPage userRole="Admin" userPermissions={[]} onNavigate={onNavigate} />
    </QueryClientProvider>,
  ) };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/receivables?')) return Promise.resolve(makeReceivablesPage());
    if (path.startsWith('/receivables/summary')) return Promise.resolve({ totalOutstanding: 130, pendingCount: 1, overdueCount: 0, partiallyPaidCount: 1, settledThisMonth: 0 });
    return Promise.resolve({ items: [] });
  });
});

describe('Receivables — no direct Collect, Open in Payments routes per source type', () => {
  it('has no Collect action anywhere on the page', async () => {
    renderReceivablesPage();
    await waitFor(() => expect(screen.getByText('TXN-0001')).toBeInTheDocument());
    expect(screen.queryByText(/^💰 Collect$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Collect Payment')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Open in Payments/i })).toHaveLength(2);
  });

  it('routes a pos_credit_sale receivable using its sourceEntityId and sourceType=pos', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderReceivablesPage();
    await waitFor(() => expect(screen.getByText('TXN-0001')).toBeInTheDocument());

    const buttons = screen.getAllByRole('button', { name: /Open in Payments/i });
    await user.click(buttons[0]);
    expect(onNavigate).toHaveBeenCalledWith('payments', { orderId: '501', sourceType: 'pos' });
  });

  it('routes an exchange_difference receivable using the receivable\'s own id and sourceType=exchange_difference', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderReceivablesPage();
    await waitFor(() => expect(screen.getByText('EXC-00000001-0001')).toBeInTheDocument());

    const buttons = screen.getAllByRole('button', { name: /Open in Payments/i });
    await user.click(buttons[1]);
    expect(onNavigate).toHaveBeenCalledWith('payments', { orderId: 'rec-exc-1', sourceType: 'exchange_difference' });
    // No payment transaction can be created directly from Receivables.
    expect(postMock).not.toHaveBeenCalledWith(expect.stringContaining('/collect'), expect.anything());
  });
});
