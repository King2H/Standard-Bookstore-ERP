// The New Order form, still the legacy one until Orders part 2 (#23):
// stock-visibility cap on quantity, and create + confirm in one action.
// The list's tests moved to OrdersFeature.test.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NewOrderLegacy from '../pages/NewOrderLegacy.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
  getCurrentBranchId: () => 1,
}));

function renderOrdersPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewOrderLegacy userRole="Admin" userPermissions={[]} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('New Order (legacy form) — Stock Visibility (create-time cap)', () => {
  beforeEach(() => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/order-books') || path.startsWith('/books/with-availability')) {
        return Promise.resolve({
          items: [{
            id: 1, title: 'Limited Stock Book', isbn: '111', defaultPrice: 20, branchPrice: 20,
            availability: { locationId: 1, locationName: 'Main', onHand: 2, reserved: 0, available: 2 },
          }],
        });
      }
      if (path.startsWith('/branches/')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [] });
    });
  });

  it('cannot increment cart quantity beyond the book\'s available stock', async () => {
    const user = userEvent.setup();
    renderOrdersPage();

    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Limited');

    await waitFor(() => expect(screen.getByText('Limited Stock Book')).toBeInTheDocument());
    await user.click(screen.getByText('Limited Stock Book'));

    // First add puts quantity at 1; the cart row's + button raises it to 2
    // (the available ceiling) — a further click must not go to 3.
    await waitFor(() => expect(screen.getByText('1', { selector: 'span' })).toBeInTheDocument());
    const plusButton = screen.getByRole('button', { name: '+' });
    await user.click(plusButton);

    await waitFor(() => expect(plusButton).toBeDisabled());
    expect(screen.getByText('2', { selector: 'span' })).toBeInTheDocument();
  });

  it('refuses to add an out-of-stock book to the cart', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/order-books') || path.startsWith('/books/with-availability')) {
        return Promise.resolve({
          items: [{
            id: 2, title: 'Sold Out Book', isbn: '222', defaultPrice: 15, branchPrice: 15,
            availability: { locationId: 1, locationName: 'Main', onHand: 0, reserved: 0, available: 0 },
          }],
        });
      }
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    renderOrdersPage();

    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Sold');

    await waitFor(() => expect(screen.getByText('Sold Out Book')).toBeInTheDocument());
    // The search-result row itself is disabled for out-of-stock books.
    const resultButton = screen.getByText('Sold Out Book').closest('button');
    expect(resultButton).toBeDisabled();
  });

  it('auto-selects the branch\'s only location so availability shows without a manual location pick', async () => {
    // Regression: book search used to key off `selectedLocationId` alone,
    // which is only ever set via the Fulfillment Location dropdown — a
    // dropdown that itself only renders when a branch has *more than one*
    // location. Single-location branches (the common case) never sent a
    // locationId at all, so availability silently never showed.
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/branches/')) return Promise.resolve({ items: [{ id: 7, name: 'Main Store', isDefaultFulfillment: true }] });
      if (path.startsWith('/order-books') || path.startsWith('/books/with-availability')) {
        return Promise.resolve({
          items: [{
            id: 3, title: 'Single Loc Book', isbn: '333', defaultPrice: 10, branchPrice: 10,
            availability: { locationId: 7, locationName: 'Main Store', onHand: 5, reserved: 0, available: 5 },
          }],
        });
      }
      return Promise.resolve({ items: [] });
    });

    const user = userEvent.setup();
    renderOrdersPage();

    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Single');

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/books/with-availability') || p.startsWith('/order-books'));
      expect(call).toContain('locationId=7');
    });
    expect(await screen.findByText('5 avail')).toBeInTheDocument();
  });
});

describe('New Order (legacy form) — Payment Method / Due Date at Creation (create+confirm)', () => {
  it('clicking Create Order on a cash sale creates AND confirms in one action, with the chosen payment method', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/order-books') || path.startsWith('/books/with-availability')) {
        return Promise.resolve({
          items: [{
            id: 9, title: 'Cash Sale Book', isbn: '999', defaultPrice: 30, branchPrice: 30,
            availability: { locationId: 1, locationName: 'Main', onHand: 10, reserved: 0, available: 10 },
          }],
        });
      }
      return Promise.resolve({ items: [] });
    });
    postMock.mockImplementation((path: string) => {
      if (path === '/orders') return Promise.resolve({ id: '20', orderNumber: 'ORD-20', saleType: 'cash_sale' });
      if (path === '/orders/20/confirm') return Promise.resolve({ id: '20', orderNumber: 'ORD-20', saleType: 'cash_sale', status: 'CONFIRMED' });
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderOrdersPage();

    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Cash Sale');
    await waitFor(() => expect(screen.getByText('Cash Sale Book')).toBeInTheDocument());
    await user.click(screen.getByText('Cash Sale Book'));

    // Default sale type is cash_sale, default payment method is Cash — the
    // form offers Telebirr as an alternative right there, no separate step.
    await waitFor(() => expect(screen.getByText('Telebirr')).toBeInTheDocument());
    await user.click(screen.getByText('Telebirr'));
    // A Telebirr payment carries its transaction number (owner decision 2a).
    await user.click(screen.getByRole('button', { name: /Create Order/i }));
    expect(postMock).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Telebirr transaction number'), ' TB-77 ');

    await user.click(screen.getByRole('button', { name: /Create Order/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/orders', expect.objectContaining({ saleType: 'cash_sale' }));
    });
    // The /orders call must NOT carry a paymentMethod field — that's the
    // confirm call's job; POST /orders itself has no such field.
    const ordersCallBody = postMock.mock.calls.find(c => c[0] === '/orders')?.[1] as Record<string, unknown>;
    expect(ordersCallBody.paymentMethod).toBeUndefined();
    expect(postMock).toHaveBeenCalledWith('/orders/20/confirm', { paymentMethod: 'mobile', transactionReference: 'TB-77' });
  });

  it('clicking Create Order on a credit sale creates AND confirms in one action, with the chosen due date', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/customers')) return Promise.resolve({ items: [{ id: 5, customerCode: 'CUST-5', fullName: 'Credit Customer' }] });
      if (path.startsWith('/order-books') || path.startsWith('/books/with-availability')) {
        return Promise.resolve({
          items: [{
            id: 8, title: 'Credit Sale Book', isbn: '888', defaultPrice: 40, branchPrice: 40,
            availability: { locationId: 1, locationName: 'Main', onHand: 10, reserved: 0, available: 10 },
          }],
        });
      }
      return Promise.resolve({ items: [] });
    });
    postMock.mockImplementation((path: string) => {
      if (path === '/orders') return Promise.resolve({ id: '21', orderNumber: 'ORD-21', saleType: 'credit_sale' });
      if (path === '/orders/21/confirm') return Promise.resolve({ id: '21', orderNumber: 'ORD-21', saleType: 'credit_sale', status: 'CONFIRMED' });
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderOrdersPage();

    await user.type(screen.getByPlaceholderText('Search customer...'), 'Credit');
    await waitFor(() => expect(screen.getByText('Credit Customer')).toBeInTheDocument());
    await user.click(screen.getByText('Credit Customer'));

    await user.click(screen.getByRole('button', { name: /Credit Sale/i }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Credit Sale');
    await waitFor(() => expect(screen.getByText('Credit Sale Book')).toBeInTheDocument());
    await user.click(screen.getByText('Credit Sale Book'));

    // No payment method picker for a credit sale — it isn't a cash form field.
    expect(screen.queryByText('Telebirr')).not.toBeInTheDocument();
    // Due Date input is offered right here instead of a separate confirm step.
    await waitFor(() => expect(screen.getByText('Due Date')).toBeInTheDocument());
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    await user.type(dateInput, '2099-12-31');

    await user.click(screen.getByRole('button', { name: /Create Order/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/orders', expect.objectContaining({ saleType: 'credit_sale' }));
    });
    // The /orders call must NOT carry a dueDate field — that's the confirm
    // call's job; POST /orders itself has no such field.
    const ordersCallBody = postMock.mock.calls.find(c => c[0] === '/orders')?.[1] as Record<string, unknown>;
    expect(ordersCallBody.dueDate).toBeUndefined();
    expect(postMock).toHaveBeenCalledWith('/orders/21/confirm', { dueDate: '2099-12-31' });
  });

  it('refuses to submit a credit sale without a due date', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve({ items: [], total: 0, page: 1, totalPages: 1 });
      if (path.startsWith('/customers')) return Promise.resolve({ items: [{ id: 5, customerCode: 'CUST-5', fullName: 'Credit Customer' }] });
      if (path.startsWith('/order-books') || path.startsWith('/books/with-availability')) {
        return Promise.resolve({
          items: [{
            id: 8, title: 'Credit Sale Book', isbn: '888', defaultPrice: 40, branchPrice: 40,
            availability: { locationId: 1, locationName: 'Main', onHand: 10, reserved: 0, available: 10 },
          }],
        });
      }
      return Promise.resolve({ items: [] });
    });

    const user = userEvent.setup();
    renderOrdersPage();

    await user.type(screen.getByPlaceholderText('Search customer...'), 'Credit');
    await waitFor(() => expect(screen.getByText('Credit Customer')).toBeInTheDocument());
    await user.click(screen.getByText('Credit Customer'));

    await user.click(screen.getByRole('button', { name: /Credit Sale/i }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Credit Sale');
    await waitFor(() => expect(screen.getByText('Credit Sale Book')).toBeInTheDocument());
    await user.click(screen.getByText('Credit Sale Book'));

    await user.click(screen.getByRole('button', { name: /Create Order/i }));

    // Validation blocks the submit client-side — no POST is ever made
    // (showToast has no visible sink in this test harness, so we assert the
    // effect that matters: nothing was submitted to the API).
    expect(postMock).not.toHaveBeenCalled();
  });
});
