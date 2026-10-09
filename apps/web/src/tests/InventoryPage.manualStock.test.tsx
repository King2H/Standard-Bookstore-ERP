// #21 inventory, part 1: Sales take stock out through POS and orders, not by
// hand; and an adjustment's reason fixes its direction (damage and loss
// remove stock, a return adds it), as the API now enforces.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InventoryPage from '../pages/InventoryPage.js';
import type { Role } from '@bms/shared';

vi.mock('../lib/api.js', () => ({
  api: { get: vi.fn(async () => ({ items: [], total: 0, page: 1, totalPages: 0 })), post: vi.fn(), put: vi.fn() },
  getAccessToken: () => 'test-token',
  getCurrentBranchId: () => 1,
}));

function renderPage(userRole: Role) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InventoryPage userRole={userRole} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Inventory manual stock changes', () => {
  it('does not offer a manual stock-out to Sales (was: allowed)', async () => {
    const user = userEvent.setup();
    renderPage('Sales');
    await user.click(screen.getByRole('button', { name: /Stock Out/ }));
    expect(screen.getByText('Access restricted')).toBeTruthy();
  });

  it('offers it to a Stock_Clerk', async () => {
    const user = userEvent.setup();
    renderPage('Stock_Clerk');
    await user.click(screen.getByRole('button', { name: /Stock Out/ }));
    expect(screen.queryByText('Access restricted')).toBeNull();
  });

  it('sets the direction from the adjustment reason (was: free for every reason)', async () => {
    const user = userEvent.setup();
    renderPage('Stock_Clerk');
    await user.click(screen.getByRole('button', { name: /Adjust/ }));
    const reason = screen.getByRole('combobox');

    await user.selectOptions(reason, 'damage');
    const toggle = screen.getByRole('button', { name: /Remove/ });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(reason, 'return');
    expect((screen.getByRole('button', { name: /Add/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(reason, 'correction');
    expect((screen.getByRole('button', { name: /Add/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
