// Prompt 2 — Procurement frontend: Paid/Outstanding columns + progress bars
// on the PO list, receiving/payment progress + credit notes on PO detail,
// and the supplier ledger quick-action view.
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

const LISTED_PO = {
  id: '42',
  branchId: 1,
  supplierId: 7,
  supplierName: 'Acme Distributors',
  status: 'partially_received',
  totalAmount: 200,
  currency: 'ETB',
  expectedDeliveryDate: null,
  createdAt: new Date().toISOString(),
  receivedValue: 100,
  amountPaid: 60,
  creditNotesTotal: 0,
  outstandingAmount: 40,
  orderedQuantityTotal: 10,
  receivedQuantityTotal: 5,
};

const DETAIL_PO = {
  ...LISTED_PO,
  currency: 'ETB',
  paymentTerms: 'credit',
  financialStatus: 'partial',
  notes: null,
  receivingBranchId: null,
  receivingLocationId: null,
  receivingLocationName: null,
  createdBy: 1,
  approvedBy: 1,
  updatedAt: new Date().toISOString(),
  lineItems: [],
  receipts: [],
  payments: [],
  creditNotes: [],
};

function makePOList() {
  return { items: [LISTED_PO], total: 1, page: 1, totalPages: 1 };
}

function renderProcurementPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProcurementPage userRole="Admin" userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/purchase-orders?')) return Promise.resolve(makePOList());
    if (path.startsWith('/purchase-orders/42')) return Promise.resolve(DETAIL_PO);
    if (path.startsWith('/suppliers/7/ledger')) {
      return Promise.resolve({
        currentBalance: 40,
        entries: [
          { date: new Date().toISOString(), type: 'PO', reference: 'PO-000042', description: 'Purchase order created (ordered value 200.00)', amount: 0, balance: 0 },
          { date: new Date().toISOString(), type: 'GOODS_RECEIPT', reference: 'GRN-1', description: 'Goods received', amount: 100, balance: 100 },
          { date: new Date().toISOString(), type: 'PAYMENT', reference: 'PAY-1', description: 'Supplier payment', amount: -60, balance: 40 },
        ],
      });
    }
    return Promise.resolve({ items: [] });
  });
});

describe('ProcurementPage — Prompt 2 UI (progress bars, ledger, credit notes)', () => {
  it('PO list shows Paid/Outstanding figures and a Ledger quick action', async () => {
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText('Acme Distributors')).toBeInTheDocument());
    expect(screen.getByText(/60\.00 paid/)).toBeInTheDocument();
    expect(screen.getByText(/40\.00 outstanding/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ledger' })).toBeInTheDocument();
  });

  it('clicking Ledger opens the Supplier Ledger view with running-balance entries', async () => {
    const user = userEvent.setup();
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText('Acme Distributors')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Ledger' }));

    await waitFor(() => expect(screen.getByText(/Supplier Ledger — Acme Distributors/)).toBeInTheDocument());
    expect(screen.getByText('GOODS RECEIPT')).toBeInTheDocument();
    expect(screen.getByText('PAYMENT')).toBeInTheDocument();
    // Current balance owed reflects the running balance from the API.
    expect(screen.getAllByText('40.00').length).toBeGreaterThan(0);
  });

  it('PO detail shows receiving/payment progress and the received-value AP basis', async () => {
    const user = userEvent.setup();
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText('Acme Distributors')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'View' }));

    await waitFor(() => expect(screen.getByText('Receiving Progress')).toBeInTheDocument());
    expect(screen.getByText('5 / 10 units')).toBeInTheDocument();
    expect(screen.getByText('Payment Progress')).toBeInTheDocument();
    expect(screen.getByText('Received Value')).toBeInTheDocument();
    expect(screen.getByText('Outstanding')).toBeInTheDocument();
  });

  it('issuing a credit note posts amount + reason and refreshes the PO', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ ...DETAIL_PO, creditNotesTotal: 40, outstandingAmount: 0, financialStatus: 'paid' });
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText('Acme Distributors')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'View' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Issue Credit Note' })).toBeInTheDocument());
    const amountInputs = screen.getAllByPlaceholderText('0.00');
    // Second "0.00" input is the credit note amount (first is supplier payment amount).
    await user.type(amountInputs[1], '40');
    await user.type(screen.getByPlaceholderText(/damaged goods/i), 'Damaged in transit');
    await user.click(screen.getByRole('button', { name: 'Issue Credit Note' }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/purchase-orders/42/credit-notes', { amount: 40, reason: 'Damaged in transit' });
    });
  });
});
