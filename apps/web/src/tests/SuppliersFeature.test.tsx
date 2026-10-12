// #23 (M6, step 2): the Suppliers pilot. The page talks to the API through
// features/suppliers (typed with the @bms/shared contracts), its form checks
// the contract's rules, and the publisher is found by typing (#95) instead of
// from a list that stopped at the API's first 100 publishers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CreateSupplierRequestSchema, MessageResponseSchema, PublisherListResponseSchema, SupplierListResponseSchema, SupplierSchema,
  type Supplier,
} from '@bms/shared';
import SuppliersPage from '../features/suppliers/pages/SuppliersPage.js';
import { supplierKeys } from '../features/suppliers/queries.js';
import { contract } from './contract.js';

const supplier = (over: Partial<Supplier> = {}): Supplier => contract(SupplierSchema, {
  id: 1, name: 'Book Distributors Inc', contactInfo: { phone: '555-1000', email: 'orders@bookdist.com' }, leadTimeDays: 5,
  pricingTerms: null, supplierType: 'external', publisherId: null, publisherName: null, isActive: true,
  isBlacklisted: false, status: 'ACTIVE', archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

// 150 publishers; the API answers at most 100 per page, as it does.
const PUBLISHERS = Array.from({ length: 150 }, (_, i) => ({
  id: i + 1, name: i === 149 ? 'Zeta Press' : `Publisher ${String(i + 1).padStart(3, '0')}`,
  status: 'ACTIVE' as const, archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
}));

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let suppliers: Supplier[];

function stubApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const u = new URL(path, 'http://x');
    if (method === 'GET' && u.pathname === '/suppliers') {
      return json(contract(SupplierListResponseSchema, { items: suppliers, total: suppliers.length, page: 1, pageSize: 10, totalPages: 1 }));
    }
    if (method === 'GET' && u.pathname === '/publishers') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const pageSize = Math.min(Number(u.searchParams.get('pageSize') ?? 50), 100);
      const items = PUBLISHERS.filter(p => p.name.toLowerCase().startsWith(q)).slice(0, pageSize);
      return json(contract(PublisherListResponseSchema, { items, total: items.length }));
    }
    if (method === 'POST' && u.pathname === '/suppliers') {
      CreateSupplierRequestSchema.parse(body);
      const created = supplier({ id: 2, ...body, publisherName: null });
      suppliers = [...suppliers, created];
      return json(created, 201);
    }
    if (method === 'PUT' && u.pathname.startsWith('/suppliers/')) return json(supplier({ ...suppliers[0], ...body }));
    if (method === 'POST') return json(contract(MessageResponseSchema, { message: 'Done' }));
    return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  }));
}

function renderPage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={qc}><SuppliersPage userRole="Admin" userPermissions={['MANAGE_INVENTORY', 'MANAGE_BRANCH']} /></QueryClientProvider>);
  return qc;
}

const posts = () => calls.filter(c => c.method === 'POST' && c.path === '/suppliers');

beforeEach(() => {
  suppliers = [supplier()];
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('Suppliers', () => {
  it('lists suppliers from GET /api/v1/suppliers, active ones by default', async () => {
    renderPage();
    expect(await screen.findByText('Book Distributors Inc')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/suppliers?page=1&pageSize=10&status=active' });
  });

  it('creates a supplier with a body the API contract accepts, then reloads the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Book Distributors Inc');

    await user.click(screen.getByRole('button', { name: '+ New Supplier' }));
    await user.type(screen.getByLabelText('Name *'), 'Addis Books');
    await user.type(screen.getByLabelText('Email'), 'sales@addis.example');
    await user.clear(screen.getByLabelText('Lead Time (days) *'));
    await user.type(screen.getByLabelText('Lead Time (days) *'), '3');
    await user.click(screen.getByRole('button', { name: 'Create Supplier' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({
      name: 'Addis Books', contactInfo: { phone: '', email: 'sales@addis.example' }, leadTimeDays: 3,
      pricingTerms: null, supplierType: 'external', publisherId: null,
    });
    expect(await screen.findByText('Addis Books')).toBeInTheDocument();
  });

  it('accepts a lead time of 0 days, as the API does (was: at least 1)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Book Distributors Inc');
    await user.click(screen.getByRole('button', { name: '+ New Supplier' }));
    await user.type(screen.getByLabelText('Name *'), 'Same Day');
    await user.clear(screen.getByLabelText('Lead Time (days) *'));
    await user.type(screen.getByLabelText('Lead Time (days) *'), '0');
    await user.click(screen.getByRole('button', { name: 'Create Supplier' }));
    await waitFor(() => expect(posts()[0]?.body).toMatchObject({ name: 'Same Day', leadTimeDays: 0 }));
  });

  it('says what is wrong and sends nothing when the form breaks the contract', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Book Distributors Inc');
    await user.click(screen.getByRole('button', { name: '+ New Supplier' }));
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Create Supplier' }));

    expect(await screen.findByText('Enter the supplier name')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('finds a publisher beyond the API\'s first 100 by typing its name (#95: it was missing from the list)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Book Distributors Inc');
    await user.click(screen.getByRole('button', { name: '+ New Supplier' }));
    await user.type(screen.getByLabelText('Name *'), 'Zeta Direct');
    await user.selectOptions(screen.getByLabelText('Supplier Type *'), 'publisher');

    await user.type(screen.getByRole('combobox', { name: 'Linked Publisher' }), 'Zeta');
    await user.click(await screen.findByRole('option', { name: 'Zeta Press' }));
    await user.click(screen.getByRole('button', { name: 'Create Supplier' }));

    await waitFor(() => expect(posts()[0]?.body).toMatchObject({ supplierType: 'publisher', publisherId: 150 }));
    expect(calls.some(c => c.path === '/publishers?q=Zeta&pageSize=20')).toBe(true);
  });

  it('asks for the publisher of a publisher supplier', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Book Distributors Inc');
    await user.click(screen.getByRole('button', { name: '+ New Supplier' }));
    await user.type(screen.getByLabelText('Name *'), 'No Publisher');
    await user.selectOptions(screen.getByLabelText('Supplier Type *'), 'publisher');
    await user.click(screen.getByRole('button', { name: 'Create Supplier' }));

    expect(await screen.findByText('Pick the publisher')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('edits a supplier: the form starts from its values and saves with PUT', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Book Distributors Inc');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Name *')).toHaveValue('Book Distributors Inc');
    expect(screen.getByLabelText('Phone')).toHaveValue('555-1000');
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '555-2222');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
    expect(calls.find(c => c.method === 'PUT')).toMatchObject({
      path: '/suppliers/1',
      body: { name: 'Book Distributors Inc', contactInfo: { phone: '555-2222', email: 'orders@bookdist.com' }, leadTimeDays: 5 },
    });
  });

  it('after a change, reloads supplier data only (targeted invalidation)', async () => {
    const user = userEvent.setup();
    const qc = renderPage();
    await screen.findByText('Book Distributors Inc');
    qc.setQueryData(['customers', 'list'], { items: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls.some(c => c.path === '/suppliers/1/deactivate')).toBe(true));

    await waitFor(() => expect(qc.getQueryState(supplierKeys.list({ page: 1, pageSize: 10, status: 'active' }))?.dataUpdateCount).toBe(2));
    expect(qc.getQueryState(['customers', 'list'])?.isInvalidated).toBe(false);
  });
});
