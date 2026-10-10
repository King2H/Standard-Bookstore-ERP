// #21 receivables: a write-off needs a reason and has its own status; only
// Admin, Manager and Finance_Officer write off or change a due date.
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

const base = {
  sourceType: 'pos_credit_sale', customerId: 1, customerName: 'Alice', customerCode: 'CUST-1', branchId: 1,
  originalAmount: 100, currency: 'ETB', dueDate: null, settlementDate: null, notes: null,
  writtenOffAt: null, writeOffReason: null, createdAt: new Date().toISOString(),
};

function page() {
  return {
    items: [
      { ...base, id: '1', sourceRefId: 'TXN-OPEN', sourceEntityId: '501', outstandingAmount: 100, status: 'Pending' },
      {
        ...base, id: '2', sourceRefId: 'TXN-GONE', sourceEntityId: '502', outstandingAmount: 0, status: 'WrittenOff',
        writtenOffAt: new Date().toISOString(), writeOffReason: 'Moved away',
      },
    ],
    total: 2, page: 1, totalPages: 1,
  };
}

function renderPage(userRole: string, userPermissions: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReceivablesPage userRole={userRole} userPermissions={userPermissions} onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue({});
  getMock.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('/receivables?') ? page() : {
      totalOutstanding: 100, pendingCount: 1, overdueCount: 0, partiallyPaidCount: 0, settledThisMonth: 0, writtenOffThisMonth: 1,
    }),
  );
});

describe('Receivables write-off', () => {
  it('needs a reason, and posts it to /write-off (was: optional notes to /settle)', async () => {
    const user = userEvent.setup();
    renderPage('Manager');
    await waitFor(() => expect(screen.getByText('TXN-OPEN')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Write Off/ }));
    const buttons = screen.getAllByRole('button', { name: /^Write Off$/ });
    const confirm = buttons[buttons.length - 1];
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/Reason/), '  Customer moved away ');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(postMock).toHaveBeenCalledWith('/receivables/1/write-off', { reason: 'Customer moved away' });
  });

  it('shows a written-off receivable as such, with no actions', async () => {
    renderPage('Manager');
    await waitFor(() => expect(screen.getByText('TXN-GONE')).toBeInTheDocument());
    const row = screen.getByText('TXN-GONE').closest('tr')!;
    expect(row).toHaveTextContent('Written off');
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('does not let staff who only take payments change a due date (was: allowed)', async () => {
    renderPage('Sales', ['PROCESS_PAYMENT']);
    await waitFor(() => expect(screen.getByText('TXN-OPEN')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Open in Payments/ })).toHaveLength(1);
    expect(screen.queryByTitle('Set due date')).toBeNull();
    expect(screen.queryByRole('button', { name: /Write Off/ })).toBeNull();
  });
});
