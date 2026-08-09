// Pagination & Layout Standardization — Part 4 UI test (Orders).
// Focused on the pagination contract: the list renders the shared
// Pagination component wired to the API's page/pageSize/total/totalPages,
// and paging/page-size changes trigger a new request with the right
// params — without touching any business logic in OrdersPage itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrdersPage from '../pages/OrdersPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  getCurrentBranchId: () => 1,
}));

function makeOrdersPage(total: number, page = 1, pageSize = 10) {
  return {
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize)) }, (_, i) => ({
      id: String((page - 1) * pageSize + i + 1),
      orderNumber: `ORD-${(page - 1) * pageSize + i + 1}`,
      customerId: null,
      branchId: 1,
      channel: 'in_store',
      status: 'CONFIRMED',
      paymentStatus: 'paid',
      currency: 'ETB',
      saleType: 'cash_sale',
      subtotal: 10,
      total: 10,
      cancelReason: null,
      createdAt: new Date().toISOString(),
      allowedActions: [],
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function renderOrdersPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersPage userRole="Admin" userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersPage(25));
    if (path.startsWith('/branches/')) return Promise.resolve({ items: [] });
    return Promise.resolve({ items: [] });
  });
});

describe('OrdersPage — pagination', () => {
  it('renders the shared Pagination control with total/page info from the API response', async () => {
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText(/Showing 1–10 of 25 orders/)).toBeInTheDocument());
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('clicking Next requests page 2 with the current page size', async () => {
    const user = userEvent.setup();
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersPage(25, 2));
      return Promise.resolve({ items: [] });
    });

    await user.click(screen.getByRole('button', { name: /next page/i }));

    await waitFor(() => {
      const ordersCall = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/orders?'));
      expect(ordersCall).toContain('page=2');
      expect(ordersCall).toContain('pageSize=10');
    });
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeInTheDocument());
  });

  it('changing the page size resets to page 1 and requests the new size', async () => {
    const user = userEvent.setup();
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersPage(25, 1, 25));
      return Promise.resolve({ items: [] });
    });

    await user.selectOptions(screen.getByDisplayValue('10'), '25');

    await waitFor(() => {
      const ordersCall = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/orders?'));
      expect(ordersCall).toContain('page=1');
      expect(ordersCall).toContain('pageSize=25');
    });
  });

  it('changing the status filter resets pagination to page 1', async () => {
    const user = userEvent.setup();
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersPage(3, 1));
      return Promise.resolve({ items: [] });
    });

    const statusSelects = screen.getAllByRole('combobox');
    const statusFilterSelect = statusSelects[0];
    await user.selectOptions(statusFilterSelect, 'CANCELLED');

    await waitFor(() => {
      const ordersCall = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/orders?'));
      expect(ordersCall).toContain('status=CANCELLED');
      expect(ordersCall).toContain('page=1');
    });
  });
});
