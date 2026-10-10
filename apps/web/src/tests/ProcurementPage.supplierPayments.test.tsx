// Supplier payables (#21): payments are numbered, use the system's method
// codes, and a mistaken one is reversed with a reason.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProcurementPage from '../pages/ProcurementPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
  getCurrentBranchId: () => 1,
  getAccessToken: () => 'test-token',
}));

const PO = {
  id: '42', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors', status: 'received',
  totalAmount: 100, currency: 'ETB', expectedDeliveryDate: null, createdAt: new Date().toISOString(),
  receivedValue: 100, amountPaid: 40, creditNotesTotal: 0, outstandingAmount: 60,
  orderedQuantityTotal: 10, receivedQuantityTotal: 10,
};

const DETAIL = {
  ...PO, paymentTerms: 'credit', financialStatus: 'partial', notes: null, receivingBranchId: 1, receivingLocationId: null,
  receivingLocationName: null, createdBy: 1, approvedBy: 2, closedReason: null, updatedAt: new Date().toISOString(),
  lineItems: [], receipts: [], creditNotes: [],
  payments: [
    { id: '9', paymentNumber: 'SPAY-20261010-0003', poId: '42', amount: 40, paymentMethod: 'bank', source: 'manual', notes: null,
      createdBy: 3, createdAt: new Date().toISOString(), reversedAt: null, reversalReason: null },
    { id: '8', paymentNumber: 'SPAY-20261010-0002', poId: '42', amount: 25, paymentMethod: 'cash', source: 'manual', notes: null,
      createdBy: 3, createdAt: new Date().toISOString(), reversedAt: new Date().toISOString(), reversalReason: 'Wrong order' },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProcurementPage userRole="Finance_Officer" userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/purchase-orders?')) return Promise.resolve({ items: [PO], total: 1, page: 1, totalPages: 1 });
    if (path.startsWith('/purchase-orders/42')) return Promise.resolve(DETAIL);
    return Promise.resolve({ items: [] });
  });
  postMock.mockResolvedValue(DETAIL);
});

async function openOrder() {
  const user = userEvent.setup();
  renderPage();
  await waitFor(() => expect(screen.getByText('Acme Distributors')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'View' }));
  await screen.findByText('SPAY-20261010-0003');
  return user;
}

describe('ProcurementPage supplier payments', () => {
  it('shows payment numbers and a reversed payment with its reason', async () => {
    await openOrder();
    expect(screen.getByText('Reversed: Wrong order')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reverse' })).toHaveLength(1);
  });

  it('reverses a payment with the reason given', async () => {
    const user = await openOrder();
    vi.spyOn(window, 'prompt').mockReturnValue('Paid twice');
    await user.click(screen.getByRole('button', { name: 'Reverse' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/purchase-orders/42/payments/9/reverse', { reason: 'Paid twice' }));
  });

  it('offers the system payment-method codes', async () => {
    await openOrder();
    const values = Array.from(document.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['cash', 'bank', 'mobile', 'cheque']));
    expect(values).not.toContain('bank_transfer');
  });
});
