// #23 (M6, step 1): every page has its own URL. The browser's Back button,
// a reload and a bookmark all land on the page they name, and a URL the user
// may not open goes to their landing page: the same rule the sidebar uses.
// Pages are stubbed here; each one's own behaviour has its own tests.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import App from '../app/App.js';
import { restoreSession } from '../lib/auth.js';
import { api } from '../lib/api.js';
import { canOpenPage, landingPage, NAV_SECTIONS, PAGES } from '../app/navigation.js';

const { pageStub, tokenRef } = vi.hoisted(() => ({
  tokenRef: { current: null as string | null },
  pageStub: (name: string) => async () => {
    const { createElement } = await import('react');
    type Props = {
      initialContext?: Record<string, string>;
      onNavigate?: (page: string, context?: Record<string, string>) => void;
      onPasswordChanged?: () => void;
      onSuccess?: () => void;
    };
    return {
      default: (props: Props) => createElement('section', { 'data-testid': 'page' },
        createElement('h2', null, name),
        createElement('pre', { 'data-testid': 'context' }, JSON.stringify(props.initialContext ?? {})),
        props.onNavigate && createElement('button', { onClick: () => props.onNavigate!('payments', { orderId: '7', sourceType: 'pos' }) }, 'Collect payment'),
        props.onPasswordChanged && createElement('button', { onClick: props.onPasswordChanged }, 'Password changed'),
        props.onSuccess && createElement('button', { onClick: () => props.onSuccess!() }, 'Sign in'),
      ),
    };
  },
}));

vi.mock('../pages/LoginPage.js', pageStub('LoginPage'));
vi.mock('../pages/DashboardPage.js', pageStub('DashboardPage'));
vi.mock('../features/branches/pages/BranchesPage.js', pageStub('BranchesPage'));
vi.mock('../pages/StaffPage.js', pageStub('StaffPage'));
vi.mock('../pages/AuditLogPage.js', pageStub('AuditLogPage'));
vi.mock('../pages/SettingsPage.js', pageStub('SettingsPage'));
vi.mock('../pages/BankAccountsPage.js', pageStub('BankAccountsPage'));
vi.mock('../features/locations/pages/LocationsPage.js', pageStub('LocationsPage'));
vi.mock('../pages/CatalogPage.js', pageStub('CatalogPage'));
vi.mock('../pages/InventoryPage.js', pageStub('InventoryPage'));
vi.mock('../features/suppliers/pages/SuppliersPage.js', pageStub('SuppliersPage'));
vi.mock('../pages/ProcurementPage.js', pageStub('ProcurementPage'));
vi.mock('../pages/CustomersPage.js', pageStub('CustomersPage'));
vi.mock('../pages/POSPage.js', pageStub('POSPage'));
vi.mock('../pages/ReturnsPage.js', pageStub('ReturnsPage'));
vi.mock('../pages/OrdersPage.js', pageStub('OrdersPage'));
vi.mock('../pages/PaymentsPage.js', pageStub('PaymentsPage'));
vi.mock('../pages/ExchangesPage.js', pageStub('ExchangesPage'));
vi.mock('../pages/ReceivablesPage.js', pageStub('ReceivablesPage'));
vi.mock('../pages/ProfilePage.js', pageStub('ProfilePage'));
vi.mock('../components/NotificationBell.js', () => ({ default: () => null }));
vi.mock('../lib/auth.js', () => ({
  restoreSession: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  switchBranch: vi.fn(),
}));
vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    getAccessToken: () => tokenRef.current,
    api: { ...actual.api, get: vi.fn().mockResolvedValue({ branches: [] }) },
  };
});

const SALES = ['CREATE_SALE', 'PROCESS_PAYMENT'];

function signedInAs(role: string, permissions: string[], mustChangePassword = false) {
  tokenRef.current = `x.${btoa(JSON.stringify({ role, roles: [role], branchId: 1 }))}.y`;
  vi.mocked(restoreSession).mockResolvedValue({ restored: true, permissions, mustChangePassword });
}

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="url">{pathname + search}</output>;
}

function BackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Browser back</button>;
}

/** Opens `url`, after visiting `before` (the browser history behind it). */
function open(url: string, before: string[] = []) {
  return render(
    <MemoryRouter initialEntries={[...before, url]}>
      <App />
      <Where />
      <BackButton />
    </MemoryRouter>,
  );
}

const menu = (label: string) => screen.getByRole('button', { name: new RegExp(`^\\W*${label}$`) });
const url = () => screen.getByTestId('url').textContent;
const page = async (name: string) => expect(await screen.findByRole('heading', { level: 2, name })).toBeInTheDocument();

beforeEach(() => {
  localStorage.setItem('bms-theme', 'light'); // jsdom has no matchMedia
  tokenRef.current = null;
  vi.mocked(restoreSession).mockResolvedValue({ restored: false, permissions: [], mustChangePassword: false });
});

describe('Pages and their URLs', () => {
  it('sends the bare address to the role\'s landing page', async () => {
    signedInAs('Sales', SALES);
    open('/');
    await page('POSPage');
    expect(url()).toBe('/pos');
  });

  it('keeps a restored session on the page in the URL: a reload stays put (was: always the landing page)', async () => {
    signedInAs('Sales', SALES);
    open('/orders');
    await page('OrdersPage');
    expect(url()).toBe('/orders');
  });

  it('gives each page its own URL, and Back returns to the previous page', async () => {
    signedInAs('Sales', SALES);
    open('/pos');
    await page('POSPage');

    await userEvent.click(menu('Orders'));
    await page('OrdersPage');
    expect(url()).toBe('/orders');

    await userEvent.click(menu('Customers'));
    await page('CustomersPage');
    expect(url()).toBe('/customers');

    await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await page('OrdersPage');
    expect(url()).toBe('/orders');
  });

  it('carries what a page hands to another in the query string, so the link can be reloaded', async () => {
    signedInAs('Sales', SALES);
    open('/pos');
    await page('POSPage');
    await userEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    await page('PaymentsPage');
    expect(url()).toBe('/payments?orderId=7&sourceType=pos');
    expect(JSON.parse(screen.getByTestId('context').textContent!)).toEqual({ orderId: '7', sourceType: 'pos' });
  });

  it('opens a link with its context straight away', async () => {
    signedInAs('Manager', ['VIEW_REPORTS', 'PROCESS_PAYMENT']);
    open('/receivables?status=Overdue');
    await page('ReceivablesPage');
    expect(JSON.parse(screen.getByTestId('context').textContent!)).toEqual({ status: 'Overdue' });
  });

  it('sends an unknown address to the landing page', async () => {
    signedInAs('Stock_Clerk', ['MANAGE_INVENTORY']);
    open('/no-such-page');
    await page('InventoryPage');
    expect(url()).toBe('/inventory');
  });

  it('shows the sign-in page at any address until signed in, then stays on that page', async () => {
    open('/customers');
    await page('LoginPage');
    signedInAs('Sales', SALES);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await page('CustomersPage');
    expect(url()).toBe('/customers');
  });
});

describe('Route guards', () => {
  it('refuses a page outside the menu: a Sales account opening /staff lands on POS, and Back cannot return to it', async () => {
    signedInAs('Sales', SALES);
    open('/staff', ['/orders']);
    await page('POSPage');
    expect(url()).toBe('/pos');
    expect(screen.queryByRole('heading', { level: 2, name: 'StaffPage' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await page('OrdersPage');
    expect(url()).toBe('/orders');
  });

  it('keeps Super_Admin out of the operational pages', async () => {
    signedInAs('Super_Admin', ['MANAGE_BRANCH', 'MANAGE_STAFF', 'VIEW_REPORTS', 'CREATE_SALE']);
    open('/pos');
    await page('DashboardPage');
    expect(url()).toBe('/dashboard');
  });

  it('opens a page a role may use (Finance_Officer → /payments)', async () => {
    signedInAs('Finance_Officer', ['PROCESS_PAYMENT', 'VIEW_REPORTS']);
    open('/payments');
    await page('PaymentsPage');
  });

  it('allows only the profile while the password must be changed, then lands as usual', async () => {
    signedInAs('Sales', SALES, true);
    open('/orders');
    await page('ProfilePage');
    expect(url()).toBe('/profile');

    if (!screen.queryByRole('button', { name: /^\W*Orders$/ })) await userEvent.click(menu('Sales'));
    await userEvent.click(menu('Orders'));
    expect(url()).toBe('/profile');

    await userEvent.click(screen.getByRole('button', { name: 'Password changed' }));
    await page('POSPage');
    expect(url()).toBe('/pos');
  });

  it('moves to the profile when the API first asks for a password change (#38)', async () => {
    signedInAs('Sales', SALES);
    open('/orders');
    await page('OrdersPage');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Change it' }), { status: 403 }),
    ));
    await act(() => api.post('/orders', {}).catch(() => {}));
    vi.unstubAllGlobals();
    await page('ProfilePage');
    expect(url()).toBe('/profile');
  });
});

describe('The navigation rule', () => {
  it('lets each role open its own landing page', () => {
    const permissionsOf: Record<string, string[]> = {
      Admin: ['VIEW_REPORTS', 'MANAGE_BRANCH', 'MANAGE_STAFF'], Manager: ['VIEW_REPORTS', 'MANAGE_BRANCH'],
      Finance_Officer: ['PROCESS_PAYMENT', 'VIEW_REPORTS'], Sales: SALES, Stock_Clerk: ['MANAGE_INVENTORY'],
      Purchasor: ['MANAGE_INVENTORY'], Super_Admin: ['MANAGE_BRANCH', 'MANAGE_STAFF'],
    };
    for (const [role, permissions] of Object.entries(permissionsOf)) {
      expect([role, canOpenPage(landingPage(role), role, permissions)]).toEqual([role, true]);
    }
  });

  it('has a route for every menu entry', () => {
    for (const item of NAV_SECTIONS.flatMap(s => s.items)) expect(PAGES).toContain(item.id);
  });
});
