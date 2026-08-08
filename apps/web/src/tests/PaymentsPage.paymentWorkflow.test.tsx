// Single Authoritative Payment Collection Workflow — Payments is the only
// module that creates payment transactions; Sales History and Receivables
// deep-link here instead. These tests cover the receiving side of that
// contract: initialContext pre-fills the Collect tab (reusing the same
// selectOrderForPayment() the Pending tab's own Collect button calls) or
// pre-filters Payment History.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PaymentsPage from '../pages/PaymentsPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: vi.fn(), patch: vi.fn() },
  getCurrentBranchId: () => 1,
}));

function makeUnpaidPage(items: unknown[]) {
  return { items, total: items.length, page: 1, totalPages: 1 };
}

function makeHistoryPage() {
  return { items: [], total: 0, page: 1, totalPages: 1 };
}

function renderPaymentsPage(initialContext?: Record<string, string>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentsPage userRole="Admin" userPermissions={[]} initialContext={initialContext} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('Payments — deep-link pre-fill from Sales History / Receivables', () => {
  it('pre-selects and lands on Collect when given an exchange_difference orderId + sourceType', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.includes('entityId=rec-exc-1') && path.includes('sourceType=exchange_difference')) {
        return Promise.resolve(makeUnpaidPage([{
          id: 'rec-exc-1', orderNumber: 'EXC-00000001-0001', customerName: 'Bob', customerCode: 'CUST-2',
          total: 50, totalPaid: 20, outstanding: 30, paymentStatus: 'partial', status: 'PartiallyPaid',
          channel: 'Exchange', createdAt: new Date().toISOString(), sourceType: 'exchange_difference',
        }]));
      }
      if (path.startsWith('/payments/unpaid-orders')) return Promise.resolve(makeUnpaidPage([]));
      if (path.startsWith('/payments')) return Promise.resolve(makeHistoryPage());
      return Promise.resolve({ items: [] });
    });

    renderPaymentsPage({ orderId: 'rec-exc-1', sourceType: 'exchange_difference' });

    await waitFor(() => expect(screen.getByText('🔁 Exchange Balance — Collecting Payment')).toBeInTheDocument());
    expect(screen.getByText('EXC-00000001-0001')).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    // Amount pre-fills to the outstanding balance.
    expect(screen.getByDisplayValue('30.00')).toBeInTheDocument();
  });

  it('opens Payment History pre-filtered when given tab=history + orderId, with a visible clear-filter chip', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/payments/unpaid-orders')) return Promise.resolve(makeUnpaidPage([]));
      if (path.startsWith('/payments')) return Promise.resolve(makeHistoryPage());
      return Promise.resolve({ items: [] });
    });

    renderPaymentsPage({ tab: 'history', orderId: 'tx-1', sourceType: 'pos' });

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/payments?'));
      expect(call).toContain('orderId=tx-1');
    });
    expect(screen.getByText(/Filtered to one sale/)).toBeInTheDocument();
  });

  it('with no initialContext, lands on Pending Payments as before (unchanged default)', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/payments/unpaid-orders')) return Promise.resolve(makeUnpaidPage([]));
      return Promise.resolve({ items: [] });
    });

    renderPaymentsPage();

    await waitFor(() => expect(screen.getByText('Orders & Credit Sales Awaiting Payment')).toBeInTheDocument());
  });
});
