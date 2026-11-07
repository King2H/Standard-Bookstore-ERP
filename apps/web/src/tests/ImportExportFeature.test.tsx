// #246 part 4 (owner decisions 1a–4a, 2026-11-07): one Import / Export page.
// Each file has its template, a check that lists every invalid row with its
// line before anything is saved, and saving all of it or only its valid rows.
// Admin and Manager bring in every list; who books stock (MANAGE_INVENTORY)
// brings in opening stock, as the API allows. Before, there was no such page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportReportSchema, ImportRequestSchema, ImportResultSchema, ProfileResponseSchema, type ImportReport, type ProfileResponse } from '@bms/shared';
import { canOpenPage, titleOf } from '../app/navigation.js';
import ImportExportPage from '../features/imports/pages/ImportExportPage.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';
import { contract } from './contract.js';

let me: ProfileResponse;
let calls: Array<{ method: string; path: string; body: unknown }>;
let checkReport: ImportReport;

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: '2026-11-07T00:00:00.000Z', mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Main', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const report = (over: Partial<ImportReport> = {}): ImportReport => contract(ImportReportSchema, {
  kind: 'catalog', rows: 2, valid: 1, toCreate: 1, toUpdate: 0, unchanged: 0,
  errors: [{ line: 3, messages: ["ISBN '123' is not a valid ISBN-13 or ISBN-10"] }], moreErrors: 0, notices: [],
  newNames: { authors: ['Haddis Alemayehu'], categories: [], publishers: [], suppliers: [] }, ...over,
});

beforeEach(() => {
  localStorage.setItem('bms-theme', 'light');
  setAccessToken('x');
  calls = [];
  me = profile(['Manager']);
  checkReport = report();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/staff/me') return json(me);
    if (path === '/imports/catalog/check') return json(checkReport);
    if (path === '/imports/catalog') return json(contract(ImportResultSchema, { ...checkReport, created: 1, updated: 0, skipped: 1 }));
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider><ImportExportPage /></ToastProvider>
  </QueryClientProvider>,
);

describe('Import / Export (#246)', () => {
  it('opens to Admin, Manager and who books stock, not to sales or the shop owner', () => {
    expect(canOpenPage('data-import', 'Admin', ['Admin'], ['MANAGE_BRANCH', 'MANAGE_INVENTORY'])).toBe(true);
    expect(canOpenPage('data-import', 'Manager', ['Manager'], ['MANAGE_INVENTORY'])).toBe(true);
    expect(canOpenPage('data-import', 'Stock_Clerk', ['Stock_Clerk'], ['MANAGE_INVENTORY'])).toBe(true);
    expect(canOpenPage('data-import', 'Sales', ['Sales'], ['CREATE_SALE'])).toBe(false);
    expect(canOpenPage('data-import', 'Super_Admin', ['Super_Admin'], ['MANAGE_BRANCH', 'MANAGE_STAFF'])).toBe(false);
  });

  it('is titled by its menu label (was: "Data Import", from its address)', () => {
    expect(titleOf('data-import')).toBe('Import / Export');
    expect(titleOf('profile')).toBe('Profile');
  });

  it('offers every list to a Manager, in the order a shop starts, and opening stock only to a stock clerk', async () => {
    show();
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['1. Catalog', '2. Opening stock', '3. Customers', '4. Customer balances', '5. Supplier balances']);

    me = profile(['Stock_Clerk']);
    document.body.innerHTML = '';
    show();
    expect((await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent)).toEqual(['2. Opening stock']);
  });

  it('checks a file first, lists each invalid row by line, and saves only the valid rows when asked', async () => {
    const user = userEvent.setup();
    show();
    const catalog = (await screen.findByRole('heading', { name: '1. Catalog' })).closest('section')!;
    const file = new File(['ISBN,SKU,Title\n9780306406157,,Fikir\n123,,Bad'], 'books.csv', { type: 'text/csv' });
    await user.upload(within(catalog).getByLabelText('Catalog file'), file);

    const sent = calls.find((c) => c.path === '/imports/catalog/check')!;
    expect(ImportRequestSchema.parse(sent.body)).toMatchObject({ fileName: 'books.csv', csv: expect.stringContaining('9780306406157') });
    expect(await within(catalog).findByText('Line 3')).toBeInTheDocument();
    expect(within(catalog).getByText("ISBN '123' is not a valid ISBN-13 or ISBN-10")).toBeInTheDocument();
    expect(within(catalog).getByText(/New authors: Haddis Alemayehu/)).toBeInTheDocument();
    // Nothing is saved while a row is wrong, unless only the valid rows are asked for.
    expect(within(catalog).queryByRole('button', { name: /^Import 2 rows/ })).toBeNull();
    expect(calls.some((c) => c.path === '/imports/catalog')).toBe(false);

    await user.click(within(catalog).getByRole('button', { name: 'Import the 1 valid row' }));
    const saved = calls.find((c) => c.path === '/imports/catalog')!;
    expect(ImportRequestSchema.parse(saved.body)).toMatchObject({ onlyValid: true, fileName: 'books.csv' });
    expect(await within(catalog).findByText('Saved: 1 created, 0 updated, 1 row left out.')).toBeInTheDocument();
  });

  it('saves a clean file in one step', async () => {
    const user = userEvent.setup();
    checkReport = report({ valid: 2, toCreate: 2, errors: [] });
    show();
    const catalog = (await screen.findByRole('heading', { name: '1. Catalog' })).closest('section')!;
    await user.upload(within(catalog).getByLabelText('Catalog file'), new File(['ISBN,SKU,Title'], 'books.csv', { type: 'text/csv' }));
    await user.click(await within(catalog).findByRole('button', { name: 'Import 2 rows' }));
    expect(ImportRequestSchema.parse(calls.find((c) => c.path === '/imports/catalog')!.body)).toMatchObject({ onlyValid: false });
  });
});
