// Regression: Quick Exchange's book search availability lookup requires a
// locationId, but `locationId` used to stay '' until the staff manually
// picked one from the required Location dropdown — so stock never showed
// until that click happened, even though a default location was already
// knowable from GET /branches/:id/locations. It's now auto-selected (the
// dropdown still lets staff override it before completing the exchange).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExchangesPage from '../pages/ExchangesPage.js';

const getMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: vi.fn() },
  getCurrentBranchId: () => 1,
}));

function renderExchangesPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExchangesPage userRole="Admin" userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/exchanges?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
    if (path.startsWith('/branches/')) return Promise.resolve({ items: [{ id: 9, name: 'Main Store', isDefaultFulfillment: true }] });
    if (path.startsWith('/books/with-availability')) {
      return Promise.resolve({
        items: [{
          id: 1, title: 'Exchange Book', isbn: '999', defaultPrice: 25, branchPrice: 25,
          availability: { locationId: 9, locationName: 'Main Store', onHand: 4, reserved: 0, available: 4 },
        }],
      });
    }
    return Promise.resolve({ items: [] });
  });
});

describe('ExchangesPage — Quick Exchange auto-selects the default location', () => {
  it('sends locationId in book search without a manual location pick, and shows availability', async () => {
    const user = userEvent.setup();
    renderExchangesPage();

    await user.click(screen.getByRole('button', { name: /Quick Exchange/i }));
    await waitFor(() => expect(screen.getByDisplayValue('Main Store (default)')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Exchange');

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/books/with-availability'));
      expect(call).toContain('locationId=9');
    });
    expect(await screen.findByText(/4 available/)).toBeInTheDocument();
  });
});
