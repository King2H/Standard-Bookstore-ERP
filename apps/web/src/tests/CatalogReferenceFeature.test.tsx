// #23 (M6, step 4): the catalog's Authors, Categories and Publishers tabs move
// to features/catalogReference. They offer only what the API accepts (editing
// for Admin, Manager and Stock_Clerk, any role held; deleting for Admin), page
// with the shared pagination, and find a parent category by typing its name
// (#95) instead of from a list that stopped at the first 200. Every mocked
// answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AuthorListResponseSchema, CategoryListResponseSchema, CreateCategoryRequestSchema, MessageResponseSchema, ProfileResponseSchema,
  PublisherListResponseSchema, type Author, type Category, type ProfileResponse,
} from '@bms/shared';
import CatalogPage from '../pages/CatalogPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

const CREATED = '2026-10-01T00:00:00.000Z';

/** The permissions the API gives each role (lib/permissions.ts), as far as these tests need them. */
const PERMISSIONS: Record<string, string[]> = {
  Admin: ['CREATE_SALE', 'MANAGE_INVENTORY', 'VIEW_REPORTS', 'MANAGE_STAFF', 'MANAGE_BRANCH'],
  Manager: ['CREATE_SALE', 'MANAGE_INVENTORY', 'VIEW_REPORTS', 'MANAGE_STAFF'],
  Stock_Clerk: ['MANAGE_INVENTORY'],
  Sales: ['CREATE_SALE', 'PROCESS_PAYMENT'],
  Purchasor: ['MANAGE_INVENTORY', 'VIEW_REPORTS'],
};

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: CREATED, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const author = (id: number, name: string): Author => ({
  id, name, normalizedName: name.toLowerCase(), status: 'ACTIVE', archivedAt: null, createdAt: CREATED, bookCount: 0,
});
const category = (id: number, name: string, parentId: number | null = null): Category => ({
  id, name, normalizedName: name.toLowerCase(), parentId, parentName: null, status: 'ACTIVE', archivedAt: null, createdAt: CREATED, bookCount: 0,
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let authors: Author[];
let categories: Category[];

/** Answers like the API: a name filter by its start, at most `max` per page. */
function page<T extends { name: string }>(all: T[], u: URL, max: number) {
  const q = (u.searchParams.get('q') ?? '').toLowerCase();
  const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 50), max);
  const pageNo = Number(u.searchParams.get('page') ?? 1);
  const found = all.filter((x) => x.name.toLowerCase().startsWith(q));
  return { items: found.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: found.length };
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
    if (method === 'GET' && u.pathname === '/authors') return json(contract(AuthorListResponseSchema, page(authors, u, 100)));
    if (method === 'GET' && u.pathname === '/categories') return json(contract(CategoryListResponseSchema, page(categories, u, 200)));
    if (method === 'GET' && u.pathname === '/publishers') return json(contract(PublisherListResponseSchema, { items: [], total: 0 }));
    if (method === 'POST' && u.pathname === '/categories') {
      const req = CreateCategoryRequestSchema.parse(body);
      return json(category(999, req.name, req.parentId ?? null), 201);
    }
    if (method === 'GET') return json({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
    return json(contract(MessageResponseSchema, { message: 'Done' }));
  }));
}

/** Lets every answer the page asked for arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

/** The page as the app shows it: the first role held, and the permissions of every role held. */
function renderTab(tab: 'Authors' | 'Categories') {
  const perms = [...new Set(me.currentRoles.flatMap((r) => PERMISSIONS[r] ?? []))];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><CatalogPage userRole={me.currentRole} userPermissions={perms} /></ToastProvider></QueryClientProvider>);
  return userEvent.setup().click(screen.getByRole('button', { name: new RegExp(tab) }));
}

const drawer = async (title: string) => (await screen.findByText(title)).closest('.shadow-2xl')! as HTMLElement;

/** The parent categories offered after typing `typed` (or all of them, from a list). */
async function parentChoices(form: HTMLElement, typed: string): Promise<string[]> {
  const picker = within(form).getByRole('combobox');
  if (picker.tagName === 'SELECT') {
    return within(picker).getAllByRole('option').filter((o) => (o as HTMLOptionElement).value !== '').map((o) => o.textContent ?? '');
  }
  await userEvent.setup().type(picker, typed);
  await waitFor(() => expect(within(form).queryByText('Searching…')).not.toBeInTheDocument());
  await settle();
  return within(form).queryAllByRole('option').map((o) => o.textContent ?? '');
}

/** Chooses `name` as the parent: from the list, or by typing it. */
async function chooseParent(form: HTMLElement, name: string) {
  const user = userEvent.setup();
  const picker = within(form).getByRole('combobox');
  if (picker.tagName === 'SELECT') {
    await user.selectOptions(picker, name);
    return;
  }
  await user.type(picker, name);
  await user.click(await within(form).findByRole('option', { name }));
}

beforeEach(() => {
  setAccessToken('x');
  authors = [author(5, 'George Orwell')];
  categories = [category(1, 'Fiction'), category(2, 'Fiction Classics', 1), category(3, 'Fantasy')];
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Catalog reference tabs: who may change them', () => {
  it('offers a Purchasor no changes, which the API refuses (was: Add, Edit, Archive and Delete)', async () => {
    me = profile(['Purchasor']);
    await renderTab('Authors');
    expect(await screen.findByText('George Orwell')).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole('button', { name: '+ Add Author' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('offers a Manager editing but not Delete, which the API keeps for Admins (was: Delete offered, then refused)', async () => {
    me = profile(['Manager']);
    await renderTab('Authors');
    expect(await screen.findByText('George Orwell')).toBeInTheDocument();
    await settle();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add Author' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('counts any role held: a Sales clerk also made Stock_Clerk edits, and an Admin deletes', async () => {
    me = profile(['Sales', 'Stock_Clerk']);
    await renderTab('Authors');
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('offers Delete to an Admin', async () => {
    me = profile(['Admin']);
    await renderTab('Authors');
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});

describe('Catalog reference tabs: paging', () => {
  it('cannot page past the end of an empty list (was: Next and Last led to empty pages)', async () => {
    me = profile(['Admin']);
    authors = [];
    await renderTab('Authors');
    expect((await screen.findAllByText('No authors found')).length).toBeGreaterThan(0);
    await settle();
    const next = screen.getAllByRole('button').find((b) => /^(Next )?›$/.test(b.textContent ?? ''))!;
    expect(next).toBeDisabled();
  });

  it('asks for one page of 25, filtered by name and status', async () => {
    me = profile(['Admin']);
    await renderTab('Authors');
    await screen.findByText('George Orwell');
    await userEvent.setup().type(screen.getByPlaceholderText('Search authors…'), 'Geo');
    await waitFor(() => expect(calls.some((c) => c.path === '/authors?q=Geo&status=active&page=1&pageSize=25')).toBe(true));
  });
});

describe('Catalog reference tabs: a category\'s parent', () => {
  it('finds a parent beyond the first 200 categories by typing its name (#95; was: only the first 200 offered)', async () => {
    me = profile(['Admin']);
    categories = Array.from({ length: 250 }, (_, i) => category(i + 1, `Topic ${String(i + 1).padStart(3, '0')}`));
    const user = userEvent.setup();
    await renderTab('Categories');
    await user.click(await screen.findByRole('button', { name: /^\+ Add Categor/ }));
    const form = await drawer('New Category');
    await user.type(within(form).getByPlaceholderText('e.g. Science Fiction'), 'Child');
    await chooseParent(form, 'Topic 240');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/categories')?.body).toEqual({ name: 'Child', parentId: 240 }));
  });

  it('does not offer a category itself or one directly under it as its parent (was: offered, then refused by the API)', async () => {
    me = profile(['Admin']);
    const user = userEvent.setup();
    await renderTab('Categories');
    const row = (await screen.findByText('Fiction')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const form = await drawer('Edit Category');
    expect(await parentChoices(form, 'F')).toEqual(['Fantasy']);
  });

  it('names the add button in the singular (was: "+ Add Categorie")', async () => {
    me = profile(['Admin']);
    await renderTab('Categories');
    expect(await screen.findByRole('button', { name: /^\+ Add Categor/ })).toHaveTextContent('+ Add Category');
  });

  it('refuses an empty name and sends nothing', async () => {
    me = profile(['Admin']);
    const user = userEvent.setup();
    await renderTab('Categories');
    await user.click(await screen.findByRole('button', { name: /^\+ Add Categor/ }));
    const form = await drawer('New Category');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Name is required')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
