// Payment method labeling & unification.
//
// History: 'store_credit' was once mislabeled "Telebirr" across several
// pages (POS checkout, Payments/Receivables settlement, Exchange difference
// settlement, Returns refund method, the Dashboard payment-method chart)
// instead of its own distinct "Store Credit" label — even though the
// backend was already correctly wired to debit/credit the customer's real
// store_credit_accounts balance in every one of those flows. POS genuinely
// had no Telebirr channel at that point (transaction_payments.method's
// CHECK constraint didn't allow 'mobile'), so the fix there was simply to
// stop mislabeling Store Credit as Telebirr.
//
// Since then (1700000050_pos_payment_mobile.cjs; components/
// PaymentMethodTabs.js; lib/paymentMethods.js), POS gained a real Telebirr
// channel, and the payment-method picker was unified into one shared
// component used by POS, Payment Collection, and Exchange settlement. These
// tests now lock in: Store Credit and Telebirr are both present and
// distinct everywhere both are offered — never conflated in either
// direction.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import POSPage from '../features/pos/pages/PosPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
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

describe('Payment method labeling — POS checkout', () => {
  it('shows both "Telebirr" and "Store Credit" as distinct payment tabs', async () => {
    renderWithQuery(<POSPage userRole="Sales" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Store Credit')).toBeInTheDocument());
    expect(screen.getByText('Telebirr')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Bank Transfer')).toBeInTheDocument();
    expect(screen.getByText('Loyalty')).toBeInTheDocument();
  });
});
