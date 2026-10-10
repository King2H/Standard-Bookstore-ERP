// Exchanges (#21): the difference is settled at the counter (owner
// decisions 2a, 3a), outgoing books are priced from the catalog (4a), a
// trade-in can be damaged (1a), and a Manager voids an exchange on its day (5a).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const BOOKS = [
  { id: 1, title: 'Fikir Eske Mekabir', isbn: '1', defaultPrice: 100, branchPrice: null, availability: null },
  { id: 2, title: 'Oromay', isbn: '2', defaultPrice: 150, branchPrice: null, availability: null },
];

const EXCHANGE = {
  id: '7', exchangeReference: 'EXC-20261010-0001', status: 'Completed', settlementType: 'Customer_Pays',
  totalIncomingValue: 40, totalOutgoingValue: 150, netBalance: 110, currency: 'ETB', createdAt: new Date().toISOString(),
  voidable: true, voidReason: null, outstandingAmount: 0, settlementStatus: 'Settled',
};

function renderPage(role = 'Manager') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExchangesPage userRole={role} userPermissions={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/exchanges?')) return Promise.resolve({ items: [EXCHANGE], total: 1, page: 1, totalPages: 1 });
    if (path.startsWith('/branches/')) return Promise.resolve({ items: [{ id: 9, name: 'Main Store', isDefaultFulfillment: true }] });
    if (path.startsWith('/books/with-availability')) {
      const q = decodeURIComponent(path.split('q=')[1] ?? '');
      return Promise.resolve({ items: BOOKS.filter(b => b.title.toLowerCase().includes(q.split('&')[0].toLowerCase())) });
    }
    return Promise.resolve({ items: [] });
  });
  postMock.mockResolvedValue(EXCHANGE);
});

async function addBook(user: ReturnType<typeof userEvent.setup>, side: 'Incoming' | 'Outgoing', search: string, title: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`Add ${side}`, 'i') }));
  await user.type(screen.getByPlaceholderText(/Search books to add as/i), search);
  await user.click(await screen.findByText(title));
}

describe('ExchangesPage — Quick Exchange', () => {
  it('sends the payment taken at the counter, a damaged trade-in, and no outgoing price', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Quick Exchange/i }));
    await waitFor(() => expect(screen.getByDisplayValue('Main Store (default)')).toBeInTheDocument());

    await addBook(user, 'Incoming', 'Fikir', 'Fikir Eske Mekabir');
    await user.selectOptions(screen.getByLabelText('Condition of Fikir Eske Mekabir'), 'damaged');
    await addBook(user, 'Outgoing', 'Oromay', 'Oromay');
    // The outgoing price is the catalog's, shown and not editable.
    expect(screen.queryByDisplayValue('150')).not.toBeInTheDocument();
    expect(screen.getByTitle('Catalog price')).toHaveTextContent('150.00');

    await user.selectOptions(screen.getByLabelText('Payment method'), 'mobile');
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [path, body] = postMock.mock.calls[0];
    expect(path).toBe('/exchanges');
    expect(body).toMatchObject({
      incomingItems: [{ bookId: 1, quantity: 1, unitPrice: 100, condition: 'damaged' }],
      outgoingItems: [{ bookId: 2, quantity: 1 }],
      payments: [{ method: 'mobile', amount: 50 }],
      allowCredit: false,
    });
    expect(body.outgoingItems[0]).not.toHaveProperty('unitPrice');
  });

  it('asks how the store gives back the difference, store credit by default', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Quick Exchange/i }));
    await waitFor(() => expect(screen.getByDisplayValue('Main Store (default)')).toBeInTheDocument());
    await addBook(user, 'Incoming', 'Oromay', 'Oromay');

    expect(screen.getByLabelText('Refund method')).toHaveValue('store_credit');
    await user.selectOptions(screen.getByLabelText('Refund method'), 'cash');
    await user.click(screen.getByRole('button', { name: 'Complete Exchange' }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0][1]).toMatchObject({ refundMethod: 'cash', payments: [] });
  });
});

describe('ExchangesPage — voiding', () => {
  it('lets a Manager void an exchange made today, with a reason', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Wrong books');
    renderPage('Manager');
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/exchanges/7/void', { reason: 'Wrong books' }));
  });

  it('offers no void to Sales', async () => {
    renderPage('Sales');
    await screen.findByText('EXC-20261010-0001');
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });
});
