// Non-Destructive Catalog Search & Virtual Receiving for Incoming Exchanges —
// frontend UI tests. Covers: (1) the Quick Catalog Register modal appearing
// when an incoming-item search comes up empty and successfully adding the
// newly-registered book to the incoming list, and (2) client-side Acquisition
// Allowance Capture / Valuation Integrity — blocking submission when an
// incoming item has no (or zero) trade-in allowance.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExchangesPage from '../pages/ExchangesPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
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
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/exchanges?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
    if (path.startsWith('/branches/')) return Promise.resolve({ items: [{ id: 9, name: 'Main Store', isDefaultFulfillment: true }] });
    if (path.startsWith('/books/with-availability')) return Promise.resolve({ items: [] });
    return Promise.resolve({ items: [] });
  });
});

async function openQuickExchange(user: ReturnType<typeof userEvent.setup>) {
  renderExchangesPage();
  await user.click(screen.getByRole('button', { name: /Quick Exchange/i }));
  await waitFor(() => expect(screen.getByDisplayValue('Main Store (default)')).toBeInTheDocument());
}

describe('ExchangesPage — Quick Catalog Register', () => {
  it('offers to quick-register a book once an incoming search comes up empty', async () => {
    const user = userEvent.setup();
    await openQuickExchange(user);

    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Nonexistent Book');

    expect(await screen.findByText(/Quick-register "Nonexistent Book" as a new catalog entry/)).toBeInTheDocument();
  });

  it('does not offer quick-register while adding outgoing items', async () => {
    const user = userEvent.setup();
    await openQuickExchange(user);

    await user.click(screen.getByRole('button', { name: /Add Outgoing/i }));
    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Nonexistent Book');

    expect(screen.queryByText(/Quick-register/)).not.toBeInTheDocument();
  });

  it('registering a new book via the modal adds it to the Incoming list', async () => {
    postMock.mockResolvedValue({ id: 42, title: 'Trade-In Novel', isbn: '', defaultPrice: null });
    const user = userEvent.setup();
    await openQuickExchange(user);

    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Trade-In Novel');
    await user.click(await screen.findByText(/Quick-register "Trade-In Novel" as a new catalog entry/));

    // Modal opens, title pre-filled from the search query.
    const modalHeading = await screen.findByText('Quick Catalog Register');
    const modal = modalHeading.closest('div')!.parentElement as HTMLElement;
    expect(within(modal).getByDisplayValue('Trade-In Novel')).toBeInTheDocument();

    await user.click(within(modal).getByRole('button', { name: /Register & Add/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/books/quick-register', expect.objectContaining({ title: 'Trade-In Novel' })));
    // Added to the incoming cart.
    expect(await screen.findByText('Trade-In Novel')).toBeInTheDocument();
  });

  it('Register & Add is disabled without a title', async () => {
    const user = userEvent.setup();
    await openQuickExchange(user);

    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Anything');
    await user.click(await screen.findByText(/Quick-register/));

    // Title pre-fills from the search query — clear it to test the guard.
    const modalHeading = await screen.findByText('Quick Catalog Register');
    const modal = modalHeading.closest('div')!.parentElement as HTMLElement;
    const titleInput = within(modal).getByDisplayValue('Anything');
    await user.clear(titleInput);

    expect(within(modal).getByRole('button', { name: /Register & Add/i })).toBeDisabled();
  });
});

describe('ExchangesPage — Acquisition Allowance Capture / Valuation Integrity', () => {
  it('blocks Complete Exchange when an incoming item has no trade-in allowance', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/exchanges?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/branches/')) return Promise.resolve({ items: [{ id: 9, name: 'Main Store', isDefaultFulfillment: true }] });
      if (path.startsWith('/books/with-availability')) {
        return Promise.resolve({ items: [{ id: 5, title: 'Some Book', isbn: '123', defaultPrice: null, branchPrice: null, availability: null }] });
      }
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    await openQuickExchange(user);

    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Some');
    await user.click(await screen.findByText('Some Book'));

    // Book with no default price adds at allowance = 0.
    await user.click(screen.getByRole('button', { name: /Complete Exchange/i }));

    expect(postMock).not.toHaveBeenCalledWith('/exchanges', expect.anything());
  });

  it('submits once a positive allowance is entered', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/exchanges?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/branches/')) return Promise.resolve({ items: [{ id: 9, name: 'Main Store', isDefaultFulfillment: true }] });
      if (path.startsWith('/books/with-availability')) {
        return Promise.resolve({ items: [{ id: 5, title: 'Some Book', isbn: '123', defaultPrice: null, branchPrice: null, availability: null }] });
      }
      if (path.startsWith('/customers?')) {
        return Promise.resolve({ items: [{ id: 77, customerCode: 'CUST-1', fullName: 'Jane Trader' }] });
      }
      return Promise.resolve({ items: [] });
    });
    postMock.mockResolvedValue({ id: 'exc-1', exchangeReference: 'EXC-1', status: 'Completed', settlementType: 'Store_Refunds', netBalance: -15, currency: 'ETB' });
    const user = userEvent.setup();
    await openQuickExchange(user);

    await user.type(screen.getByPlaceholderText(/Search books to add as/i), 'Some');
    await user.click(await screen.findByText('Some Book'));

    const allowanceInput = screen.getByTitle(/Customer Allowance Value/);
    await user.clear(allowanceInput);
    await user.type(allowanceInput, '15');

    // A non-Even settlement (this trade-in has no outgoing item) requires a
    // customer to post the resulting store credit against.
    await user.type(screen.getByPlaceholderText(/Search customer by name or code/i), 'Jane');
    await user.click(await screen.findByText('Jane Trader'));

    await user.click(screen.getByRole('button', { name: /Complete Exchange/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/exchanges', expect.objectContaining({
      customerId: 77,
      incomingItems: [expect.objectContaining({ bookId: 5, unitPrice: 15 })],
    })));
  });
});
