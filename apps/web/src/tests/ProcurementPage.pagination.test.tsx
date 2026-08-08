// Pagination & Layout Standardization — Part 4 UI test (Procurement).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProcurementPage from '../pages/ProcurementPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  getCurrentBranchId: () => 1,
}));

function makePOPage(total: number, page = 1, pageSize = 10) {
  return {
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize)) }, (_, i) => ({
      id: String((page - 1) * pageSize + i + 1),
      branchId: 1,
      supplierId: 1,
      supplierName: 'Test Supplier',
      status: 'draft',
      totalAmount: 100,
      currency: 'ETB',
      createdAt: new Date().toISOString(),
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
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
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/purchase-orders?')) return Promise.resolve(makePOPage(17));
    return Promise.resolve({ items: [] });
  });
});

describe('ProcurementPage — pagination', () => {
  it('renders the shared Pagination control with total/page info from the API response', async () => {
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText(/Showing 1–10 of 17 purchase orders/)).toBeInTheDocument());
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('clicking Last jumps straight to the final page', async () => {
    const user = userEvent.setup();
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/purchase-orders?')) return Promise.resolve(makePOPage(17, 2));
      return Promise.resolve({ items: [] });
    });

    await user.click(screen.getByRole('button', { name: /last page/i }));

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/purchase-orders?'));
      expect(call).toContain('page=2');
    });
    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
  });

  it('changing the page size requests the new size and resets to page 1', async () => {
    const user = userEvent.setup();
    renderProcurementPage();

    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
    getMock.mockClear();
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/purchase-orders?')) return Promise.resolve(makePOPage(17, 1, 50));
      return Promise.resolve({ items: [] });
    });

    await user.selectOptions(screen.getByDisplayValue('10'), '50');

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/purchase-orders?'));
      expect(call).toContain('pageSize=50');
      expect(call).toContain('page=1');
    });
  });
});
