// #169 PR 1 (owner decisions 1a, 2a, 3a, 4a): the catalog's Services tab.
// Every role reads the list; Admin and Manager add and change services, run
// the lifecycle and set their branch's fee. The form checks the contract's
// rules before sending. Before, the catalog had no Services tab. Every mocked
// answer is checked against its contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BookLookupListResponseSchema, ProfileResponseSchema, ServiceBranchFeeRequestSchema, ServiceListResponseSchema, ServiceRequestSchema,
  ServiceSchema, type ProfileResponse, type Service,
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

const service = (over: Partial<Service> = {}): Service => contract(ServiceSchema, {
  id: 1, code: 'BIND-CLOTH', name: 'Cloth binding', kind: 'binding', formatId: 2, formatLabel: 'Hardcover',
  fee: 150, branchFee: null, effectiveFee: 150, standardCost: 60, discountable: false, turnaroundDays: 3, status: 'ACTIVE',
  createdAt: CREATED, updatedAt: CREATED, ...over,
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let me: ProfileResponse;
let services: Service[];

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
    if (u.pathname === '/config/currency') return json({ currency: 'ETB' });
    if (u.pathname === '/book-formats') {
      return json(contract(BookLookupListResponseSchema, { items: [{ id: 2, code: 'HARDCOVER', label: 'Hardcover', sortOrder: 1 }] }));
    }
    if (method === 'GET' && u.pathname === '/services') {
      return json(contract(ServiceListResponseSchema, { items: services, total: services.length, page: 1, pageSize: 25, totalPages: 1 }));
    }
    if (method === 'POST' && u.pathname === '/services') {
      const req = ServiceRequestSchema.parse(body);
      return json(service({ id: 5, code: req.code.toUpperCase(), name: req.name }), 201);
    }
    const fee = u.pathname.match(/^\/services\/(\d+)\/branch-fee$/);
    if (fee && method === 'PUT') {
      const req = ServiceBranchFeeRequestSchema.parse(body);
      return json(service({ branchFee: Number(req.fee), effectiveFee: Number(req.fee) }));
    }
    if (fee && method === 'DELETE') return json(service());
    const action = u.pathname.match(/^\/services\/(\d+)\/(activate|deactivate|archive|restore)$/);
    if (action) return json(service({ status: action[2] === 'deactivate' ? 'INACTIVE' : action[2] === 'archive' ? 'ARCHIVED' : 'ACTIVE' }));
    if (method === 'GET') return json({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
    return json({ message: 'Done' });
  }));
}

/** Lets every answer the page asked for arrive, so a missing button is really missing. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function openServices() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><CatalogPage /></ToastProvider></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Services/ }));
  await screen.findByText('Cloth binding');
  await settle();
  return user;
}

const row = (name: string) => screen.getByText(name).closest('tr')! as HTMLElement;

describe('Catalog: Services tab (#169)', () => {
  beforeEach(() => {
    setAccessToken('t');
    services = [service(), service({ id: 2, code: 'BIND-LEATHER', name: 'Leather binding', fee: 250, branchFee: 280, effectiveFee: 280, discountable: true, turnaroundDays: 1 })];
    stubApi();
  });
  afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

  it('shows every role the list with the effective fee of the branch, read-only for Sales (1a, 3a)', async () => {
    me = profile(['Sales']);
    await openServices();
    const leather = row('Leather binding');
    expect(within(leather).getByText('ETB 280.00')).toBeTruthy();
    expect(within(leather).getByText('this branch · shop ETB 250.00')).toBeTruthy();
    expect(within(leather).getByText('1 day')).toBeTruthy();
    expect(within(row('Cloth binding')).getByText('Hardcover')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+ Add Service' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Branch fee' })).toBeNull();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('lets a Manager add a service, checked with the contract before it is sent (1a, 4a)', async () => {
    me = profile(['Manager']);
    const user = await openServices();
    await user.click(screen.getByRole('button', { name: '+ Add Service' }));
    await user.type(await screen.findByLabelText('Code *'), 'bind-gilt');
    await user.type(screen.getByLabelText('Name *'), 'Gilt binding');
    await user.type(screen.getByLabelText('Fee (ETB) *'), '0');
    await user.clear(screen.getByLabelText('Turnaround (days) *'));
    await user.type(screen.getByLabelText('Turnaround (days) *'), '1.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Pick the cover')).toBeTruthy();
    expect(screen.getByText('An amount above 0, e.g. 250.00')).toBeTruthy();
    expect(screen.getByText('Whole days, 0 or more')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.selectOptions(screen.getByLabelText('Cover it produces *'), 'Hardcover');
    await user.clear(screen.getByLabelText('Fee (ETB) *'));
    await user.type(screen.getByLabelText('Fee (ETB) *'), '300');
    await user.clear(screen.getByLabelText('Turnaround (days) *'));
    await user.type(screen.getByLabelText('Turnaround (days) *'), '7');
    await user.click(screen.getByLabelText('A sale may discount the fee'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST', path: '/services',
      body: { code: 'bind-gilt', name: 'Gilt binding', kind: 'binding', formatId: 2, fee: '300', standardCost: '0.00', discountable: true, turnaroundDays: 7 },
    });
    expect(await screen.findByText('Service added')).toBeTruthy();
  });

  it('lets a Manager set this branch\'s fee and go back to the shop\'s (2a)', async () => {
    me = profile(['Manager']);
    const user = await openServices();
    await user.click(within(row('Cloth binding')).getByRole('button', { name: 'Branch fee' }));
    const dialog = screen.getByRole('dialog', { name: 'Branch fee: Cloth binding' });
    expect(within(dialog).queryByRole('button', { name: 'Use the shop fee' })).toBeNull();
    await user.type(within(dialog).getByLabelText('This branch\'s fee (ETB)'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('An amount above 0, e.g. 250.00');
    await user.clear(within(dialog).getByLabelText('This branch\'s fee (ETB)'));
    await user.type(within(dialog).getByLabelText('This branch\'s fee (ETB)'), '175.50');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/services/1/branch-fee', body: { fee: '175.50' } }]);

    await user.click(within(row('Leather binding')).getByRole('button', { name: 'Branch fee' }));
    const leather = screen.getByRole('dialog', { name: 'Branch fee: Leather binding' });
    expect((within(leather).getByLabelText('This branch\'s fee (ETB)') as HTMLInputElement).value).toBe('280.00');
    await user.click(within(leather).getByRole('button', { name: 'Use the shop fee' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/services/2/branch-fee')).toBe(true));
  });

  it('offers the lifecycle actions the status allows (4a)', async () => {
    me = profile(['Admin']);
    services = [service(), service({ id: 3, code: 'BIND-OLD', name: 'Old binding', status: 'ARCHIVED' })];
    const user = await openServices();
    expect(within(row('Old binding')).queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(within(row('Old binding')).queryByRole('button', { name: 'Archive' })).toBeNull();
    await user.click(within(row('Old binding')).getByRole('button', { name: 'Restore' }));
    await user.click(within(row('Cloth binding')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/services/3/restore', '/services/1/deactivate']));
  });

  it('keeps the list away from Stock_Clerk changes too (1a)', async () => {
    me = profile(['Stock_Clerk']);
    await openServices();
    expect(screen.queryByRole('button', { name: '+ Add Service' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });
});
