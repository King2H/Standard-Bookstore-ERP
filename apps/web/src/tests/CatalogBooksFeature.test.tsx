// #23 (M6, step 4): the catalog's book list moves to features/catalog. It
// offers only what the API accepts (editing for Admin, Manager and
// Stock_Clerk, any role held; deleting for Admin), says which books a bulk
// change could not change, filters by tag, sends the search as typed, finds
// an author or category filter by typing (#95), shows prices in the shop's
// currency to every role, and pages with the shared pagination. Every mocked
// answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthorListResponseSchema, BookListResponseSchema, BookSchema, CategoryListResponseSchema, CurrencyResponseSchema,
  MessageResponseSchema, ProfileResponseSchema, SystemConfigListResponseSchema, type Author, type Book, type Category,
  type ProfileResponse,
} from '@bms/shared';
import CatalogPage from '../features/catalog/pages/CatalogPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const book = (id: number, title: string, over: Partial<Book> = {}): Book => contract(BookSchema, {
  id, isbn: `97803064061${String(id).padStart(2, '0')}`, sku: null, title, authors: ['George Orwell'], authorIds: [5], genre: null,
  publisher: null, publisherId: null, formatId: null, formatCode: null, formatLabel: null, editionId: null, editionCode: null,
  editionLabel: null, edition: null, language: null, format: null, description: null, coverImageUrl: null, defaultPrice: 10,
  tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, categories: [], categoryIds: [], tags: [],
  ...over,
});

const author = (id: number, name: string): Author => ({
  id, name, normalizedName: name.toLowerCase(), status: 'ACTIVE', archivedAt: null, createdAt: CREATED, bookCount: 0,
});
const category = (id: number, name: string): Category => ({
  id, name, normalizedName: name.toLowerCase(), parentId: null, parentName: null, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, bookCount: 0,
});

type Call = { method: string; path: string };
let calls: Call[];
let me: ProfileResponse;
let books: Book[];
let authors: Author[];
let categories: Category[];

/** Answers like the API: a name filter by its start, at most `max` per page. */
function names<T extends { name: string }>(all: T[], u: URL, max: number) {
  const q = (u.searchParams.get('q') ?? '').toLowerCase();
  const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 50), max);
  const found = all.filter((x) => x.name.toLowerCase().startsWith(q));
  return { items: found.slice(0, pageSize), total: found.length };
}

const MAY_READ_SETTINGS = ['Super_Admin', 'Admin', 'Manager'];

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, path });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: 'USD' }));
    if (u.pathname === '/config/system') {
      if (!me.currentRoles.some((r) => MAY_READ_SETTINGS.includes(r))) return json({ error: 'FORBIDDEN', message: 'Not permitted' }, 403);
      return json(contract(SystemConfigListResponseSchema, { items: [{ key: 'base_currency', value: 'USD', updatedBy: 1, updatedAt: CREATED }], total: 1 }));
    }
    if (method === 'GET' && u.pathname === '/books') {
      const pageSize = Number(u.searchParams.get('pageSize') ?? 25);
      return json(contract(BookListResponseSchema, { items: books.slice(0, pageSize), total: books.length, page: 1, pageSize, totalPages: Math.ceil(books.length / pageSize) }));
    }
    if (method === 'GET' && u.pathname === '/authors') return json(contract(AuthorListResponseSchema, names(authors, u, 100)));
    if (method === 'GET' && u.pathname === '/categories') return json(contract(CategoryListResponseSchema, names(categories, u, 200)));
    const action = u.pathname.match(/^\/books\/(\d+)\/reactivate$/);
    if (method === 'POST' && action && books.find((b) => b.id === Number(action[1]))?.status === 'ARCHIVED') {
      return json({ error: 'INVALID_LIFECYCLE_TRANSITION', message: 'An archived book comes back only by restore' }, 422);
    }
    if (method === 'GET') return json({ items: [], total: 0 });
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

/** Lets every answer the page asked for arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function renderBooks() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><CatalogPage /></ToastProvider></QueryClientProvider>);
  await screen.findByText(books[0]?.title ?? 'No books yet');
  await settle();
}

/** The actions in a book's "⋯" menu. */
async function menuOf(title: string): Promise<string[]> {
  const row = screen.getByText(title).closest('tr')!;
  await userEvent.setup().click(within(row).getByTitle('Actions'));
  const labels = [...row.querySelectorAll('button')].map((b) => b.textContent?.replace(/^\W+/u, '').trim() ?? '');
  return labels.filter((l) => l && l !== title);
}

const booksAsked = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/books?')).map((c) => new URL(c.path, 'http://x').searchParams);

/** The toolbar filter whose empty choice reads `label`: a list, or a box to type in. */
function filter(label: string): HTMLElement {
  return screen.getAllByRole('combobox').find((c) => (c.tagName === 'SELECT'
    ? within(c).queryByRole('option', { name: label }) !== null
    : c.getAttribute('aria-label') === label))!;
}

/** Chooses `name` in a filter: from its list, or by typing it. */
async function chooseIn(control: HTMLElement, name: string) {
  const user = userEvent.setup();
  if (control.tagName === 'SELECT') {
    await user.selectOptions(control, name);
    return;
  }
  await user.type(control, name);
  await user.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  setAccessToken('x');
  window.history.replaceState(null, '', '/catalog');
  books = [book(1, 'Animal Farm'), book(2, 'Nineteen Eighty-Four')];
  authors = [author(5, 'George Orwell')];
  categories = [category(1, 'Fiction')];
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Book list: who may change books', () => {
  it('offers a Purchasor no changes, which the API refuses (was: Add, Edit, status changes and Delete)', async () => {
    me = profile(['Purchasor']);
    await renderBooks();
    expect(screen.queryByRole('button', { name: '+ Add Book' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(await menuOf('Animal Farm')).toEqual(['View details']);
  });

  it('offers a Manager editing but not Delete, which the API keeps for Admins (was: Delete offered, then refused)', async () => {
    me = profile(['Manager']);
    await renderBooks();
    expect(screen.getByRole('button', { name: '+ Add Book' })).toBeInTheDocument();
    expect(await menuOf('Animal Farm')).toEqual(['View details', 'Edit', 'Deactivate', 'Archive']);
  });

  it('offers an Admin Delete', async () => {
    me = profile(['Admin']);
    await renderBooks();
    expect(await menuOf('Animal Farm')).toContain('Delete');
  });
});

describe('Book list: bulk status changes', () => {
  it('says which books the API refused (was: every book counted as changed)', async () => {
    me = profile(['Admin']);
    books = [book(1, 'Animal Farm', { status: 'INACTIVE', isActive: false }), book(2, 'Burmese Days', { status: 'ARCHIVED', isActive: false })];
    const user = userEvent.setup();
    await renderBooks();
    for (const title of ['Animal Farm', 'Burmese Days']) {
      await user.click(within(screen.getByText(title).closest('tr')!).getByRole('checkbox'));
    }
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/1 of 2 reactivated; 1 refused: An archived book comes back only by restore/)).toBeInTheDocument();
    expect(screen.queryByText('2 reactivated')).not.toBeInTheDocument();
  });
});

describe('Book list: search and filters', () => {
  it('filters by tag (was: the tag was kept in the address but never sent)', async () => {
    me = profile(['Admin']);
    const user = userEvent.setup();
    await renderBooks();
    await user.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('⚙'))!);
    await user.type(screen.getByPlaceholderText('e.g. bestseller'), 'bestseller');
    await waitFor(() => expect(booksAsked().some((p) => p.get('tag') === 'bestseller')).toBe(true));
  });

  it('finds a title that looks like a code (was: "Catch22" searched only SKUs)', async () => {
    me = profile(['Admin']);
    await renderBooks();
    await userEvent.setup().type(screen.getByPlaceholderText('Search title, author, ISBN, SKU…'), 'Catch22');
    await waitFor(() => expect(booksAsked().some((p) => p.get('q') === 'Catch22')).toBe(true));
    expect(booksAsked().some((p) => p.has('sku'))).toBe(false);
  });

  it.each([
    ['an author', 'author', 'All Authors', () => { authors = Array.from({ length: 150 }, (_, i) => author(i + 1, `Writer ${String(i + 1).padStart(3, '0')}`)); }, 'Writer 140'],
    ['a category', 'category', 'All Categories', () => { categories = Array.from({ length: 250 }, (_, i) => category(i + 1, `Topic ${String(i + 1).padStart(3, '0')}`)); }, 'Topic 240'],
  ])('finds %s to filter by however many there are, by typing (#95; was: the first 100 or 200 only)', async (_, param, label, seed, name) => {
    me = profile(['Admin']);
    seed();
    await renderBooks();
    await chooseIn(filter(label), name);
    await waitFor(() => expect(booksAsked().some((p) => p.get(param) === name)).toBe(true));
  });
});

describe('Book list: prices and paging', () => {
  it('shows prices in the shop\'s currency to a Stock Clerk (was: ETB, as the settings it read are not theirs to read)', async () => {
    me = profile(['Stock_Clerk']);
    await renderBooks();
    expect(within(screen.getByText('Animal Farm').closest('tr')!).getByText('USD 10.00')).toBeInTheDocument();
  });

  it('cannot page past the end of an empty list (was: Next and Last led to empty pages)', async () => {
    me = profile(['Admin']);
    books = [];
    await renderBooks();
    const next = screen.getAllByRole('button').find((b) => /^(Next )?›$/.test(b.textContent ?? ''))!;
    expect(next).toBeDisabled();
  });
});
