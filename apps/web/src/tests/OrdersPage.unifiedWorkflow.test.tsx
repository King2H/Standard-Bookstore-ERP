// Unified Order Creation Workflow Enhancements — frontend UI tests.
// Covers: (1) stock-visibility cap on quantity when adding/incrementing a
// cart line beyond available branch inventory, (2) the cash_sale confirm
// prompt for payment method (mirrors the existing credit_sale due-date
// prompt), and (3) order-detail surfacing of paymentMethod/dueDate once the
// API returns them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OrdersPage from '../pages/OrdersPage.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
  getCurrentBranchId: () => 1,
}));

function renderOrdersPage(onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { onNavigate, ...render(
    <QueryClientProvider client={qc}>
      <OrdersPage userRole="Admin" userPermissions={[]} onNavigate={onNavigate} />
    </QueryClientProvider>,
  ) };
}

function makeOrdersListPage(order: Record<string, unknown>) {
  return { items: [order], total: 1, page: 1, totalPages: 1 };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('OrdersPage — Stock Visibility (create-time cap)', () => {
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

    await user.click(screen.getByRole('button', { name: /New Order/i }));
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

    await user.click(screen.getByRole('button', { name: /New Order/i }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Sold');

    await waitFor(() => expect(screen.getByText('Sold Out Book')).toBeInTheDocument());
    // The search-result row itself is disabled for out-of-stock books.
    const resultButton = screen.getByText('Sold Out Book').closest('button');
    expect(resultButton).toBeDisabled();
  });
});

describe('OrdersPage — Payment Mode Capture (cash_sale confirm)', () => {
  it('prompts for a payment method before confirming a cash_sale order, and submits it', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) {
        return Promise.resolve(makeOrdersListPage({
          id: '10', orderNumber: 'ORD-1', customerId: null, branchId: 1, channel: 'in_store',
          status: 'DRAFT', paymentStatus: 'unpaid', currency: 'ETB', saleType: 'cash_sale',
          subtotal: 50, total: 50, cancelReason: null, createdAt: new Date().toISOString(),
          allowedActions: ['confirm', 'cancel'],
        }));
      }
      return Promise.resolve({ items: [] });
    });
    postMock.mockResolvedValue({ id: '10', status: 'CONFIRMED', paymentMethod: 'bank' });

    const user = userEvent.setup();
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('ORD-1')).toBeInTheDocument());

    // No payment method chosen yet — plain confirm is not offered directly,
    // the staff must open the payment-method prompt first.
    const openButton = await screen.findByRole('button', { name: /Confirm \(set payment method\)/i });
    await user.click(openButton);

    const row = screen.getByText('ORD-1').closest('tr') as HTMLElement;
    const select = within(row).getByRole('combobox');
    const okButton = within(row).getByRole('button', { name: 'OK' });
    expect(okButton).toBeDisabled();

    await user.selectOptions(select, 'bank');
    expect(okButton).not.toBeDisabled();
    await user.click(okButton);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/orders/10/confirm', { paymentMethod: 'bank' });
    });
  });

  it("credit_sale confirm's due-date input rejects dates before today", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) {
        return Promise.resolve(makeOrdersListPage({
          id: '11', orderNumber: 'ORD-2', customerId: 5, branchId: 1, channel: 'in_store',
          status: 'DRAFT', paymentStatus: 'unpaid', currency: 'ETB', saleType: 'credit_sale',
          subtotal: 50, total: 50, cancelReason: null, createdAt: new Date().toISOString(),
          allowedActions: ['confirm', 'cancel'],
        }));
      }
      return Promise.resolve({ items: [] });
    });

    const user = userEvent.setup();
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('ORD-2')).toBeInTheDocument());
    const openButton = await screen.findByRole('button', { name: /Confirm \(set due date\)/i });
    await user.click(openButton);

    // The list view also renders dateFrom/dateTo filter inputs above the
    // table (no min set on those) — the confirm prompt's own date input is
    // the last one in the DOM.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    const dateInput = dateInputs[dateInputs.length - 1] as HTMLInputElement;
    expect(dateInput).toBeTruthy();
    expect(dateInput.min).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('OrdersPage — order detail surfaces payment method and due date', () => {
  it('shows payment method and due date once the API returns them', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) {
        return Promise.resolve(makeOrdersListPage({
          id: '12', orderNumber: 'ORD-3', customerId: 5, branchId: 1, channel: 'in_store',
          status: 'CONFIRMED', paymentStatus: 'unpaid', currency: 'ETB', saleType: 'credit_sale',
          subtotal: 50, total: 50, cancelReason: null, createdAt: new Date().toISOString(),
          allowedActions: [],
        }));
      }
      if (path === '/orders/12') {
        return Promise.resolve({
          status: 'CONFIRMED', saleType: 'credit_sale',
          paymentMethod: null, dueDate: '2099-12-31',
          lineItems: [{ id: 'li1', orderId: '12', bookId: 1, bookTitle: 'Some Book', bookIsbn: '000', quantity: 1, unitPrice: 50, discountAmount: 0, totalPrice: 50, qtyReserved: 1, qtyFulfilled: 0, isBackordered: false }],
        });
      }
      return Promise.resolve({ items: [] });
    });

    const user = userEvent.setup();
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('ORD-3')).toBeInTheDocument());
    await user.click(screen.getByText('ORD-3'));

    await waitFor(() => expect(screen.getByText('2099-12-31')).toBeInTheDocument());
    expect(screen.getByText(/Due date/)).toBeInTheDocument();
  });
});

describe('OrdersPage — View Payments (unpaid/partial, i.e. credit orders)', () => {
  function makeOrder(overrides: Record<string, unknown>) {
    return {
      id: '20', orderNumber: 'ORD-20', customerId: 5, branchId: 1, channel: 'in_store',
      status: 'CONFIRMED', currency: 'ETB', saleType: 'credit_sale',
      subtotal: 100, total: 100, cancelReason: null, createdAt: new Date().toISOString(),
      allowedActions: [],
      ...overrides,
    };
  }

  it('shows View Payments for an unpaid order and deep-links to Payments\' Collect tab', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersListPage(makeOrder({ paymentStatus: 'unpaid' })));
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    const { onNavigate } = renderOrdersPage();

    await waitFor(() => expect(screen.getByText('ORD-20')).toBeInTheDocument());
    const row = screen.getByText('ORD-20').closest('tr') as HTMLElement;
    const viewBtn = within(row).getByRole('button', { name: /View Payments/i });

    await user.click(viewBtn);
    expect(onNavigate).toHaveBeenCalledWith('payments', { orderId: '20', sourceType: 'order' });
  });

  it('shows View Payments for a partially-paid order', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersListPage(makeOrder({ paymentStatus: 'partial' })));
      return Promise.resolve({ items: [] });
    });
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('ORD-20')).toBeInTheDocument());
    const row = screen.getByText('ORD-20').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: /View Payments/i })).toBeInTheDocument();
  });

  it('hides View Payments for a fully-paid order — nothing left to collect', async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/orders?')) return Promise.resolve(makeOrdersListPage(makeOrder({ paymentStatus: 'paid', saleType: 'cash_sale' })));
      return Promise.resolve({ items: [] });
    });
    renderOrdersPage();

    await waitFor(() => expect(screen.getByText('ORD-20')).toBeInTheDocument());
    const row = screen.getByText('ORD-20').closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /View Payments/i })).not.toBeInTheDocument();
  });
});
