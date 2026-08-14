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

    await user.click(screen.getByRole('button', { name: /New Order/i }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Single');

    await waitFor(() => {
      const call = getMock.mock.calls.map(c => c[0] as string).find(p => p.startsWith('/books/with-availability') || p.startsWith('/order-books'));
      expect(call).toContain('locationId=7');
    });
    expect(await screen.findByText('5 avail')).toBeInTheDocument();
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

describe('OrdersPage — Payment Method / Due Date at Creation (create+confirm)', () => {
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

    await user.click(screen.getByRole('button', { name: /New Order/i }));
    await user.type(screen.getByPlaceholderText('Search books to add...'), 'Cash Sale');
    await waitFor(() => expect(screen.getByText('Cash Sale Book')).toBeInTheDocument());
    await user.click(screen.getByText('Cash Sale Book'));

    // Default sale type is cash_sale, default payment method is Cash — the
    // form offers Telebirr as an alternative right there, no separate step.
    await waitFor(() => expect(screen.getByText('Telebirr')).toBeInTheDocument());
    await user.click(screen.getByText('Telebirr'));

    await user.click(screen.getByRole('button', { name: /Create Order/i }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/orders', expect.objectContaining({ saleType: 'cash_sale' }));
    });
    // The /orders call must NOT carry a paymentMethod field — that's the
    // confirm call's job; POST /orders itself has no such field.
    const ordersCallBody = postMock.mock.calls.find(c => c[0] === '/orders')?.[1] as Record<string, unknown>;
    expect(ordersCallBody.paymentMethod).toBeUndefined();
    expect(postMock).toHaveBeenCalledWith('/orders/20/confirm', { paymentMethod: 'mobile' });
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

    await user.click(screen.getByRole('button', { name: /New Order/i }));
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

    await user.click(screen.getByRole('button', { name: /New Order/i }));
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
