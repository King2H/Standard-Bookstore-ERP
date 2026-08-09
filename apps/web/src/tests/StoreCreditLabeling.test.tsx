// Bug fix: 'store_credit' was mislabeled "Telebirr" across several pages
// (POS checkout, Payments/Receivables settlement, Exchange difference
// settlement, Returns refund method, the Dashboard payment-method chart)
// instead of its own distinct "Store Credit" label — even though the
// backend was already correctly wired to debit/credit the customer's real
// store_credit_accounts balance in every one of those flows. OrdersPage.tsx
// already had this right (mobile = Telebirr, store_credit = Store Credit,
// as two distinct options); these tests lock in that the other pages now
// match it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import POSPage from '../pages/POSPage.js';
import PaymentsPage from '../pages/PaymentsPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: vi.fn(), put: vi.fn() },
  getCurrentBranchId: () => 1,
  getAccessToken: () => 'test-token',
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation(() => Promise.resolve({ items: [] }));
});

describe('Store Credit labeling — POS checkout', () => {
  it('shows a "Store Credit" payment tab, not "Telebirr"', async () => {
    renderWithQuery(<POSPage userRole="Sales" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Store Credit')).toBeInTheDocument());
    expect(screen.queryByText('Telebirr')).not.toBeInTheDocument();
  });
});

describe('Store Credit labeling — Payments module', () => {
  it('the Collect form\'s payment method selector lists "Store Credit" as its own distinct option from "Telebirr"', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.includes('entityId=order-1') && path.includes('sourceType=order_credit_sale')) {
        return Promise.resolve({
          items: [{
            id: 'order-1', orderNumber: 'ORD-0001', customerName: 'Alice', customerCode: 'CUST-1',
            total: 100, totalPaid: 0, outstanding: 100, paymentStatus: 'unpaid', status: 'CONFIRMED',
            channel: 'in_store', createdAt: new Date().toISOString(), sourceType: 'order_credit_sale',
          }],
          total: 1, page: 1, totalPages: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PaymentsPage userRole="Manager" userPermissions={[]} initialContext={{ orderId: 'order-1', sourceType: 'order_credit_sale' }} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('ORD-0001')).toBeInTheDocument());
    // Collect form's method <select> is built from METHOD_LABELS — both
    // labels should be present and distinct (not both reading "Telebirr").
    await waitFor(() => expect(screen.getByText(/🎁 Store Credit/)).toBeInTheDocument());
    expect(screen.getByText(/📱 Telebirr/)).toBeInTheDocument();
  });
});
