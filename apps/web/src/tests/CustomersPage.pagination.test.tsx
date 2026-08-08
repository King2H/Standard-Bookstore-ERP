// Pagination & Layout Standardization — Part 4 UI test (Customers).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CustomersPage from '../pages/CustomersPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  getCurrentBranchId: () => 1,
}));

function makeCustomersPage(total: number, page = 1, pageSize = 10) {
  return {
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize)) }, (_, i) => ({
      id: (page - 1) * pageSize + i + 1,
      branchId: 1,
      customerCode: `CUST-${(page - 1) * pageSize + i + 1}`,
      fullName: `Customer ${(page - 1) * pageSize + i + 1}`,
      phone: null,
      email: null,
      gender: null,
      dateOfBirth: null,
      address: null,
      city: null,
      isActive: true,
      createdAt: new Date().toISOString(),
      loyaltyBalance: 0,
      lifetimePoints: 0,
      storeCreditBalance: 0,
      outstandingReceivables: 0,
      groups: [],
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function renderCustomersPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomersPage userRole="Admin" userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/customers?')) return Promise.resolve(makeCustomersPage(32));
    return Promise.resolve({ items: [] });
  });
});

describe('CustomersPage — pagination', () => {
  it('renders the shared Pagination control with total/page info from the API response', async () => {
    renderCustomersPage();

    await waitFor(() => expect(screen.getByText(/Showing 1–10 of 32 customers/)).toBeInTheDocument());
    expect(screen.getByText('Page 1 of 4')).toBeInTheDocument();
  });

  it('clicking Next requests page 2 with the current page size', async () => {
    const user = userEvent.setup();
    renderCustomersPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 4')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) return Promise.resolve(makeCustomersPage(32, 2));
      return Promise.resolve({ items: [] });
    });

    await user.click(screen.getByRole('button', { name: /next page/i }));

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/customers?'));
      expect(call).toContain('page=2');
      expect(call).toContain('pageSize=10');
    });
    await waitFor(() => expect(screen.getByText('Page 2 of 4')).toBeInTheDocument());
  });

  it('changing the page size resets to page 1 and requests the new size', async () => {
    const user = userEvent.setup();
    renderCustomersPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 4')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) return Promise.resolve(makeCustomersPage(32, 1, 25));
      return Promise.resolve({ items: [] });
    });

    await user.selectOptions(screen.getByDisplayValue('10'), '25');

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/customers?'));
      expect(call).toContain('page=1');
      expect(call).toContain('pageSize=25');
    });
  });

  it('changing the status filter resets pagination to page 1', async () => {
    const user = userEvent.setup();
    renderCustomersPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 4')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) return Promise.resolve(makeCustomersPage(5, 1));
      return Promise.resolve({ items: [] });
    });

    await user.selectOptions(screen.getByDisplayValue('All Status'), 'true');

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/customers?'));
      expect(call).toContain('isActive=true');
      expect(call).toContain('page=1');
    });
  });
});
