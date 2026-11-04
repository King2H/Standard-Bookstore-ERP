// #21 inventory, part 1: Sales take stock out through POS and orders, not by
// hand; and an adjustment's reason fixes its direction (damage and loss
// remove stock, a return adds it), as the API now enforces.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InventoryPage from '../features/inventory/pages/InventoryPage.js';
import type { Role } from '@bms/shared';

let heldRoles: string[] = [];

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api.js')>(),
  api: {
    // The page reads the roles held from the signed-in account.
    get: vi.fn(async (path: string) => (path === '/staff/me' ? { currentRoles: heldRoles } : { items: [], total: 0, page: 1, totalPages: 0 })),
    post: vi.fn(),
    put: vi.fn(),
  },
  getAccessToken: () => 'test-token',
  getCurrentBranchId: () => 1,
}));

function renderPage(userRole: Role) {
  heldRoles = [userRole];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InventoryPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Inventory manual stock changes', () => {
  it('does not offer a manual stock-out to Sales (was: allowed)', async () => {
    renderPage('Sales');
    await screen.findByRole('button', { name: /Stock Levels/ });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /Stock Out/ })).toBeNull();
  });

  it('offers no Stock Out tab to anyone: Adjust → Loss / Theft does the same, with its reason (#238, S12)', async () => {
    renderPage('Stock_Clerk');
    expect(await screen.findByRole('button', { name: /Adjust/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stock Out/ })).toBeNull();
  });

  it('takes no customer return: Returns does, with its refund (#238, S12; was: "Customer Return" here)', async () => {
    const user = userEvent.setup();
    renderPage('Stock_Clerk');
    await user.click(await screen.findByRole('button', { name: /Adjust/ }));
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['correction', 'damage', 'loss']);
  });

  it('says a damaged copy is set aside in damaged stock, not lost (#238, S14)', async () => {
    const user = userEvent.setup();
    renderPage('Stock_Clerk');
    await user.click(await screen.findByRole('button', { name: /Adjust/ }));
    await user.selectOptions(screen.getByRole('combobox'), 'damage');
    expect(screen.getByText(/moves to damaged stock at its cost/)).toBeInTheDocument();
  });

  it('sets the direction from the adjustment reason (was: free for every reason)', async () => {
    const user = userEvent.setup();
    renderPage('Stock_Clerk');
    await user.click(await screen.findByRole('button', { name: /Adjust/ }));
    const reason = screen.getByRole('combobox');

    await user.selectOptions(reason, 'damage');
    const toggle = screen.getByRole('button', { name: /Remove/ });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(reason, 'correction');
    expect((screen.getByRole('button', { name: /Add/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
