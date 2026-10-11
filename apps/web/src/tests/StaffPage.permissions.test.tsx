// #21 auth part 2: the Staff page offers only what the signed-in staff member
// may do, and creates an account with its roles in one request.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StaffPage from '../pages/StaffPage.js';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    put: (...args: unknown[]) => putMock(...args),
  },
  getAccessToken: () => 'token',
}));

const member = (id: number, username: string, role: string, canManage: boolean) => ({
  id, username, fullName: `Full ${username}`, isActive: true, isAllBranches: false, createdAt: '2026-10-01T00:00:00Z',
  roles: [{ branchId: 1, branchName: 'Main', role }], lockedUntil: null, mustChangePassword: false, canManage,
});

function renderPage(userRoles: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StaffPage userRoles={userRoles} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  putMock.mockReset();
  postMock.mockResolvedValue({ staffId: 99 });
  putMock.mockResolvedValue({});
  getMock.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/branches'
        ? { items: [{ id: 1, name: 'Main', isActive: true }] }
        : { items: [member(1, 'boss', 'Admin', false), member(2, 'clerk', 'Sales', true)], total: 2 },
    ),
  );
});

const row = async (username: string) => (await screen.findByText(username)).closest('tr')!;

describe('Staff page permissions', () => {
  it('gives a Manager role editing only, with roles below Manager, and no account actions (was: everything)', async () => {
    renderPage(['Manager']);
    expect(within(await row('boss')).queryByTitle('Edit branch & role assignments')).toBeNull();

    const clerk = await row('clerk');
    expect(within(clerk).queryByTitle('Deactivate staff')).toBeNull();
    expect(within(clerk).queryByTitle(/Reset password/)).toBeNull();
    expect(within(clerk).queryByTitle(/all-branch access/)).toBeNull();
    expect(screen.queryByText('+ New Staff')).toBeNull();

    await userEvent.click(within(clerk).getByTitle('Edit branch & role assignments'));
    const options = within(clerk).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Sales');
    expect(options).not.toContain('Manager');
    expect(options).not.toContain('Admin');
  });

  it('creates an account with its roles in one request, offering an Admin no Admin role and no all-branch access', async () => {
    renderPage(['Admin']);
    await userEvent.click(await screen.findByText('+ New Staff'));
    expect(screen.queryByText(/All Branches/)).toBeNull();

    const form = screen.getByText('Create Staff Account').closest('form')!;
    const roleOptions = within(form).getAllByRole('option').map((o) => o.textContent);
    expect(roleOptions).not.toContain('Admin');
    expect(roleOptions).toContain('Manager');

    await userEvent.type(screen.getByPlaceholderText('e.g. john.doe'), 'new.clerk');
    await userEvent.type(screen.getByPlaceholderText('e.g. John Doe'), 'New Clerk');
    await userEvent.type(screen.getByPlaceholderText('Min 10 chars'), 'Temp#2026pass');
    await userEvent.selectOptions(within(form).getAllByRole('combobox')[0], '1');
    await userEvent.click(screen.getByText('Create Staff'));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/staff', {
      username: 'new.clerk', password: 'Temp#2026pass', fullName: 'New Clerk',
      roles: [{ branchId: 1, role: 'Sales' }], isAllBranches: false,
    });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('offers all-branch access to a Super_Admin', async () => {
    renderPage(['Super_Admin']);
    expect(within(await row('clerk')).getByTitle('Grant all-branch access')).toBeTruthy();
  });
});
