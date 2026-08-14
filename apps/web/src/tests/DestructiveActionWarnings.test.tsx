// Cancel/Delete/Archive operations should always warn before firing —
// locks in the confirm() gate added to the Archive and Delete actions that
// were previously single-click (Books, Authors/Categories/Publishers,
// Suppliers). Cancel actions (Orders, Exchanges, Procurement POs) already
// had a confirm step and are unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CatalogPage from '../pages/CatalogPage.js';
import SuppliersPage from '../pages/SuppliersPage.js';

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
    put: vi.fn(),
  },
  getCurrentBranchId: () => 1,
}));

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const book = {
  id: 1, isbn: '9781234567897', sku: null, title: 'Archive Me',
  authors: [], authorIds: [], genre: null, publisher: null, publisherId: null,
  formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null,
  defaultPrice: 10, tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null,
  createdAt: new Date().toISOString(), categories: [], categoryIds: [], tags: [],
};

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
  postMock.mockResolvedValue({});
  deleteMock.mockResolvedValue({});
});

describe('CatalogPage — Books: Archive/Delete warn before firing', () => {
  beforeEach(() => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/books?')) return Promise.resolve({ items: [book], total: 1, page: 1, totalPages: 1 });
      if (path.startsWith('/config/system')) return Promise.resolve({ items: [{ key: 'base_currency', value: 'ETB' }] });
      return Promise.resolve({ items: [], total: 0 });
    });
  });

  it('cancelling the Archive confirm does not call the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderWithClient(<CatalogPage userRole="Admin" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Archive Me')).toBeInTheDocument());
    await user.click(screen.getByTitle('Actions'));
    await user.click(screen.getByText('Archive'));

    expect(confirmSpy).toHaveBeenCalledWith('Archive "Archive Me"?');
    expect(postMock).not.toHaveBeenCalledWith('/books/1/archive');
    confirmSpy.mockRestore();
  });

  it('accepting the Archive confirm calls the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderWithClient(<CatalogPage userRole="Admin" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Archive Me')).toBeInTheDocument());
    await user.click(screen.getByTitle('Actions'));
    await user.click(screen.getByText('Archive'));

    expect(confirmSpy).toHaveBeenCalledWith('Archive "Archive Me"?');
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/books/1/archive'));
    confirmSpy.mockRestore();
  });

  it('cancelling the Delete confirm does not call the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderWithClient(<CatalogPage userRole="Admin" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Archive Me')).toBeInTheDocument());
    await user.click(screen.getByTitle('Actions'));
    await user.click(screen.getByText('Delete'));

    expect(confirmSpy).toHaveBeenCalledWith('Delete "Archive Me"? This cannot be undone.');
    expect(deleteMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('CatalogPage — Authors: Archive warns before firing', () => {
  beforeEach(() => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/authors?')) {
        return Promise.resolve({
          items: [{ id: 5, name: 'Archive Author', status: 'ACTIVE', archivedAt: null, bookCount: 0, createdAt: new Date().toISOString() }],
          total: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
  });

  it('cancelling the Archive confirm does not call the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderWithClient(<CatalogPage userRole="Admin" userPermissions={[]} />);

    await user.click(screen.getByRole('button', { name: /Authors/i }));
    await waitFor(() => expect(screen.getByText('Archive Author')).toBeInTheDocument());
    await user.click(screen.getByText('Archive'));

    expect(confirmSpy).toHaveBeenCalledWith('Archive "Archive Author"?');
    expect(postMock).not.toHaveBeenCalledWith('/authors/5/archive');
    confirmSpy.mockRestore();
  });
});

describe('SuppliersPage — Archive warns before firing', () => {
  beforeEach(() => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith('/suppliers?')) {
        return Promise.resolve({
          items: [{
            id: 9, name: 'Archive Supplier', contactInfo: {}, leadTimeDays: 5,
            pricingTerms: null, supplierType: 'external', publisherId: null, publisherName: null,
            isActive: true, isBlacklisted: false, status: 'ACTIVE', archivedAt: null,
            createdAt: new Date().toISOString(),
          }],
          total: 1, page: 1, totalPages: 1,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });
  });

  it('cancelling the Archive confirm does not call the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderWithClient(<SuppliersPage userRole="Admin" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Archive Supplier')).toBeInTheDocument());
    await user.click(screen.getByText('Archive'));

    expect(confirmSpy).toHaveBeenCalledWith('Archive "Archive Supplier"?');
    expect(postMock).not.toHaveBeenCalledWith('/suppliers/9/archive');
    confirmSpy.mockRestore();
  });

  it('accepting the Archive confirm calls the API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderWithClient(<SuppliersPage userRole="Admin" userPermissions={[]} />);

    await waitFor(() => expect(screen.getByText('Archive Supplier')).toBeInTheDocument());
    await user.click(screen.getByText('Archive'));

    expect(confirmSpy).toHaveBeenCalledWith('Archive "Archive Supplier"?');
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/suppliers/9/archive'));
    confirmSpy.mockRestore();
  });
});
