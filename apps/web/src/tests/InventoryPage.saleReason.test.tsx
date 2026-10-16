// #109: stock leaving in a sale is recorded with reason "sale"; the history
// shows each row's reason and can be filtered to sales.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InventoryPage from '../pages/InventoryPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: { get: (...args: unknown[]) => getMock(...args), post: vi.fn(), put: vi.fn() },
  getAccessToken: () => 'test-token',
  getCurrentBranchId: () => 1,
}));

const saleRow = {
  id: '1', bookId: 1, bookTitle: 'Sold Book', locationId: 1, locationName: 'Shop', qtyBefore: 5, qtyAfter: 4, delta: -1,
  movementType: 'stock_out', reasonCode: 'sale', referenceType: 'sale', referenceId: '9', notes: null, staffId: 1,
  staffUsername: 'clerk', createdAt: '2026-10-11T09:00:00Z',
};

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('/inventory/history') ? { items: [saleRow], total: 1, page: 1, totalPages: 1 } : { items: [], total: 0, page: 1, totalPages: 0 }),
  );
});

describe('Stock history reasons', () => {
  it('shows a sale as "Sale" and filters by it (was: no such reason)', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><InventoryPage userRole="Stock_Clerk" /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: /History/ }));

    const row = (await screen.findByText('Sold Book')).closest('tr')!;
    expect(within(row).getByText('Sale')).toBeTruthy();

    const [, reasonFilter] = screen.getAllByRole('combobox');
    await user.selectOptions(reasonFilter, 'sale');
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining('reasonCode=sale'));
  });
});
