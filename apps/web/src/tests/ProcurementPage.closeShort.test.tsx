// Purchase orders (#21): a part-received order closes short with a reason
// (asked in the app's own dialog since #23),
// and orders are in ETB, so the form offers no currency to type.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProcurementPage from '../features/procurement/pages/ProcurementPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
  getCurrentBranchId: () => 1,
  getAccessToken: () => 'test-token',
}));

const PO = {
  id: '42', branchId: 1, supplierId: 7, supplierName: 'Acme Distributors', status: 'partially_received',
  totalAmount: 200, currency: 'ETB', expectedDeliveryDate: null, createdAt: new Date().toISOString(),
  receivedValue: 100, amountPaid: 0, creditNotesTotal: 0, outstandingAmount: 100,
  orderedQuantityTotal: 10, receivedQuantityTotal: 5,
};

const DETAIL = {
  ...PO, paymentTerms: 'credit', financialStatus: 'unpaid', notes: null, receivingBranchId: 1, receivingLocationId: null,
  receivingLocationName: null, createdBy: 1, approvedBy: 2, closedReason: null, updatedAt: new Date().toISOString(),
  lineItems: [], receipts: [], payments: [], creditNotes: [],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProcurementPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path === '/staff/me') return Promise.resolve({ id: 5, currentRoles: ['Manager'], currentBranchId: 1 });
    if (path.startsWith('/purchase-orders?')) return Promise.resolve({ items: [PO], total: 1, page: 1, totalPages: 1 });
    if (path.startsWith('/purchase-orders/42')) return Promise.resolve(DETAIL);
    return Promise.resolve({ items: [] });
  });
  postMock.mockResolvedValue({ ...DETAIL, status: 'closed', closedReason: 'Out of print' });
});

describe('ProcurementPage', () => {
  it('closes a part-received order short with the reason given', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme Distributors')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'View' }));

    await user.click(await screen.findByRole('button', { name: 'Close Short' }));
    await user.type(screen.getByLabelText('Why will the rest not be delivered?'), 'Out of print');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close Short' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/purchase-orders/42/close', { reason: 'Out of print' }));
  });

  it('offers no currency to type on a new order', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /New PO/ }));
    expect(await screen.findByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('ETB')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('ETB')).not.toBeInTheDocument();
  });
});
