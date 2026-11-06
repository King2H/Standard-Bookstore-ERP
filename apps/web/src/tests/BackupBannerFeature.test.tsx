// #244 (owner decision 3a, 2026-11-06): Admin and Super_Admin are warned
// across the app when the install has had no good backup for 26 hours, with
// the last failure's reason. Nothing shows where backups are not set up, or
// to other roles, who do not ask for it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BackupStatusSchema, ProfileResponseSchema, type BackupStatus, type ProfileResponse } from '@bms/shared';
import { BackupBanner } from '../features/system/components/BackupBanner.js';
import { setAccessToken, setCurrentBranchId } from '../lib/api.js';
import { contract } from './contract.js';

const AT = '2026-11-05T23:30:00.000Z';
let me: ProfileResponse;
let status: BackupStatus;
let asked: string[];

function profile(roles: string[]): ProfileResponse {
  return contract(ProfileResponseSchema, {
    id: 9, username: 'me', fullName: 'Me', isActive: true, createdAt: AT, mustChangePassword: false,
    lastLoginAt: null, passwordChangedAt: null, isLocked: false, isAllBranches: false,
    roles: roles.map((role) => ({ branchId: 1, branchName: 'Home', role })),
    currentRole: roles[0], currentRoles: roles, currentBranchId: 1, locationAccess: { mode: 'full', locations: [] },
  });
}

const backups = (over: Partial<BackupStatus> = {}): BackupStatus => contract(BackupStatusSchema, {
  enabled: true, lastSuccessAt: AT, lastFile: 'bookstore-20261105-233000.bmsbak', lastFailureAt: null, lastError: null, stale: false, ...over,
});

beforeEach(() => {
  setAccessToken('x');
  setCurrentBranchId(1);
  me = profile(['Admin']);
  status = backups();
  asked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(/^.*\/api\/v1/, '');
    asked.push(path);
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/staff/me') return json(me);
    if (path === '/system/backup-status') return json(status);
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); setCurrentBranchId(null); });

const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BackupBanner /></QueryClientProvider>);
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

describe('the backup warning (#244, 3a)', () => {
  it('tells an Admin when there has been no good backup for more than a day, and why the last one failed', async () => {
    status = backups({ stale: true, lastFailureAt: '2026-11-06T23:30:00.000Z', lastError: 'No space left on device' });
    show();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/No backup for more than a day/);
    expect(banner).toHaveTextContent(/Last good backup: .*2026/);
    expect(banner).toHaveTextContent('The last attempt failed: No space left on device');
  });

  it('tells a Super_Admin when no backup has been made yet', async () => {
    me = profile(['Super_Admin']);
    status = backups({ stale: true, lastSuccessAt: null, lastFile: null });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(/No backup has been made yet/);
  });

  it('says nothing while backups are current, or where they are not set up', async () => {
    show();
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    status = backups({ enabled: false, lastSuccessAt: null, lastFile: null, stale: false });
    show();
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not ask for it for other roles', async () => {
    me = profile(['Manager']);
    show();
    await settle();
    expect(asked).not.toContain('/system/backup-status');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
