// #23 (M6, step 4) and #95: the book form is rebuilt on the shared contract.
// Authors, categories and the publisher are found by typing, so every one can
// be picked however many there are; the book's own links show as chips, even
// an inactive author; a field emptied on edit is cleared; the contract's
// limits are checked before sending; and the form no longer promises prices
// it cannot set. Every mocked answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthorListResponseSchema, BookListResponseSchema, BookLookupListResponseSchema, BookSchema, CategoryListResponseSchema,
  CreateBookRequestSchema, CurrencyResponseSchema, ProfileResponseSchema, PublisherListResponseSchema, UpdateBookRequestSchema,
  type Book, type ProfileResponse,
} from '@bms/shared';
import CatalogPage from '../features/catalog/pages/CatalogPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

const me: ProfileResponse = contract(ProfileResponseSchema, {
  id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
  lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
  roles: [{ branchId: 1, branchName: 'Home', role: 'Admin' }],
  currentRole: 'Admin', currentRoles: ['Admin'], currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
});

const book = (over: Partial<Book> = {}): Book => contract(BookSchema, {
  id: 1, isbn: '9780306406157', sku: null, title: 'Animal Farm', authors: ['George Orwell'], authorIds: [1], genre: 'Fiction',
  publisher: 'Publisher 007', publisherId: 7, formatId: 1, formatCode: 'PB', formatLabel: 'Paperback', editionId: 1,
  editionCode: 'FIRST', editionLabel: 'First', edition: null, language: 'English', format: null, description: null,
  coverImageUrl: null, defaultPrice: 10, tradeValue: null, isActive: true, status: 'ACTIVE', archivedAt: null, createdAt: CREATED,
  categories: [], categoryIds: [], tags: [], ...over,
});

const named = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({
  id: i + 1, name: i === 0 && prefix === 'Writer' ? 'George Orwell' : `${prefix} ${String(i + 1).padStart(3, '0')}`,
  status: 'ACTIVE' as const, archivedAt: null, createdAt: CREATED,
}));
// 150 of each, active only, as the API lists them; at most 100 a page.
const AUTHORS = named('Writer', 150).map((a) => ({ ...a, normalizedName: a.name.toLowerCase(), bookCount: 0 }));
const PUBLISHERS = named('Publisher', 150);
const CATEGORIES = named('Topic', 10).map((c) => ({ ...c, normalizedName: c.name.toLowerCase(), parentId: null }));
const LOOKUPS = {
  '/book-formats': [{ id: 1, code: 'PB', label: 'Paperback', sortOrder: 1 }, { id: 2, code: 'HB', label: 'Hardcover', sortOrder: 2 }],
  '/book-editions': [{ id: 1, code: 'FIRST', label: 'First', sortOrder: 1 }],
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let books: Book[];

function names<T extends { name: string }>(all: T[], u: URL, max: number) {
  const q = (u.searchParams.get('q') ?? '').toLowerCase();
  const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 50), max);
  const found = all.filter((x) => x.name.toLowerCase().startsWith(q));
  return { items: found.slice(0, pageSize), total: found.length };
}

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (u.pathname === '/staff/me') return json(contract(ProfileResponseSchema, me));
    if (u.pathname === '/config/currency') return json(contract(CurrencyResponseSchema, { currency: 'ETB' }));
    if (u.pathname in LOOKUPS) return json(contract(BookLookupListResponseSchema, { items: LOOKUPS[u.pathname as keyof typeof LOOKUPS] }));
    if (u.pathname === '/authors') return json(contract(AuthorListResponseSchema, names(AUTHORS, u, 100)));
    if (u.pathname === '/publishers') return json(contract(PublisherListResponseSchema, names(PUBLISHERS, u, 100)));
    if (u.pathname === '/categories') return json(contract(CategoryListResponseSchema, names(CATEGORIES, u, 200)));
    if (method === 'GET' && u.pathname === '/books') {
      return json(contract(BookListResponseSchema, { items: books, total: books.length, page: 1, pageSize: 25, totalPages: 1 }));
    }
    if (method === 'POST' && u.pathname === '/books') return json(book({ ...CreateBookRequestSchema.parse(body), id: 2 } as Partial<Book>), 201);
    if (method === 'PUT' && u.pathname === '/books/1') {
      UpdateBookRequestSchema.parse(body);
      return json(books[0]);
    }
    return json({ items: [], total: 0 });
  }));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const sent = (method: string) => calls.find((c) => c.method === method && c.path.startsWith('/books') && !c.path.startsWith('/books?'));

async function openForm(which: 'add' | 'edit'): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><CatalogPage /></ToastProvider></QueryClientProvider>);
  const user = userEvent.setup();
  if (which === 'add') {
    await user.click(await screen.findByRole('button', { name: '+ Add Book' }));
  } else {
    const row = (await screen.findByText(books[0].title)).closest('tr')!;
    await user.click(within(row).getByTitle('Actions'));
    await user.click(within(row).getByText('Edit'));
  }
  const form = (await screen.findByText(which === 'add' ? 'Add Book' : 'Edit Book', { selector: 'h3' })).closest('.shadow-2xl') as HTMLElement;
  await settle();
  return form;
}

const tab = (form: HTMLElement, name: string) => userEvent.setup().click(within(form).getByRole('button', { name }));

/** The control under a label, whether the label names it or only sits above it. */
function field(form: HTMLElement, label: RegExp): HTMLElement {
  const el = within(form).getByText(label, { selector: 'label' });
  return (el.parentElement!.querySelector('input, select, textarea') as HTMLElement);
}

/** Chooses `name` in a single-choice control: from its list, or by typing it. */
async function choose(form: HTMLElement, control: HTMLElement, name: string) {
  const user = userEvent.setup();
  if (control.tagName === 'SELECT') {
    await user.selectOptions(control, name);
    return;
  }
  await user.type(control, name);
  await user.click(await within(form).findByRole('option', { name }));
}

/** Types into the authors search and picks `name` from what it offers. */
async function pickAuthor(form: HTMLElement, name: string) {
  const user = userEvent.setup();
  await user.type(within(form).getByPlaceholderText('Search authors…'), name);
  await settle();
  await user.click(await within(form).findByText(name, { selector: 'li, span' }));
}

/** Fills what a new book needs, apart from what a test sets itself. */
async function fillRequired(form: HTMLElement, { author = true } = {}) {
  const user = userEvent.setup();
  await user.type(field(form, /^Title/), 'New Book');
  await tab(form, 'Physical');
  await user.selectOptions(field(form, /^Book Format/), 'Paperback');
  await user.selectOptions(field(form, /^Edition/), 'First');
  if (author) {
    await tab(form, 'Authors');
    await pickAuthor(form, 'George Orwell');
  }
}

beforeEach(() => {
  setAccessToken('x');
  window.history.replaceState(null, '', '/catalog');
  books = [book()];
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Book form: picking authors, categories and publishers (#95)', () => {
  it('finds an author beyond the first 100 by typing (was: only the first 100 offered)', async () => {
    const form = await openForm('add');
    await fillRequired(form, { author: false });
    await tab(form, 'Authors');
    await pickAuthor(form, 'Writer 140');
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect((sent('POST')?.body as { authorIds: number[] }).authorIds).toEqual([140]));
  });

  it('finds a publisher beyond the first 100 by typing (was: only the first 100 offered)', async () => {
    const form = await openForm('add');
    await fillRequired(form);
    await tab(form, 'Basic Info');
    await choose(form, field(form, /^Publisher/), 'Publisher 140');
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect((sent('POST')?.body as { publisherId: number }).publisherId).toBe(140));
  });

  it('shows an inactive author the book names, and removes it (was: hidden, and sent again on every save)', async () => {
    books = [book({ authors: ['George Orwell', 'Retired Writer'], authorIds: [1, 999] })];
    const form = await openForm('edit');
    await tab(form, 'Authors');
    expect(within(form).getByText('Retired Writer')).toBeInTheDocument();
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Remove Retired Writer' }));
    await userEvent.setup().click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect((sent('PUT')?.body as { authorIds: number[] }).authorIds).toEqual([1]));
  });
});

describe('Book form: what is sent', () => {
  it('clears a publisher and a genre emptied on edit (was: left out, so they kept their old values)', async () => {
    const user = userEvent.setup();
    const form = await openForm('edit');
    const publisher = field(form, /^Publisher/);
    if (publisher.tagName === 'SELECT') await user.selectOptions(publisher, '');
    else await user.clear(publisher);
    await user.clear(field(form, /^Genre/));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT')?.body).toMatchObject({ publisherId: null, genre: '' }));
  });

  it('checks the contract\'s limits before sending (was: a title over 500 characters sent and refused)', async () => {
    const user = userEvent.setup();
    const form = await openForm('add');
    await fillRequired(form);
    await tab(form, 'Basic Info');
    await user.click(field(form, /^Title/));
    await user.paste('x'.repeat(495));
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByText('At most 500 characters')).toBeInTheDocument();
    expect(sent('POST')).toBeUndefined();
  });

  it('says a price cannot be removed on edit (was: the emptied price was left out, and kept, without a word)', async () => {
    const user = userEvent.setup();
    const form = await openForm('edit');
    await tab(form, 'Pricing');
    await user.clear(field(form, /^Default Price/));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('A price cannot be removed; enter 0 for none')).toBeInTheDocument();
    expect(sent('PUT')).toBeUndefined();
  });

  it('creates a book with what was entered', async () => {
    const user = userEvent.setup();
    const form = await openForm('add');
    await user.type(field(form, /^ISBN/), '978-0-306-40615-7');
    await fillRequired(form);
    await tab(form, 'Categories');
    await user.type(within(form).getByPlaceholderText('Search categories…'), 'Topic 003');
    await settle();
    await user.click(await within(form).findByText('Topic 003', { selector: 'li, span' }));
    await user.type(field(form, /^Tags/), 'bestseller, award');
    await tab(form, 'Pricing');
    await user.type(field(form, /^Default Price/), '12.50');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(sent('POST')?.body).toMatchObject({
      isbn: '9780306406157', title: 'New Book', authorIds: [1], categoryIds: [3], formatId: 1, editionId: 1,
      tags: ['bestseller', 'award'], defaultPrice: 12.5,
    }));
  });
});

describe('Book form: what it promises', () => {
  it('no longer promises prices it cannot set (was: "set from the book\'s action menu", which has no such action)', async () => {
    const form = await openForm('edit');
    await tab(form, 'Physical');
    expect(within(form).queryByText(/pricing can be set/)).not.toBeInTheDocument();
    await tab(form, 'Pricing');
    expect(within(form).queryByText(/action menu/)).not.toBeInTheDocument();
  });
});
