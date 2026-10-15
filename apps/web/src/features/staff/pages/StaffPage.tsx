import React, { useState } from 'react';
import type { CreateStaffRequest, SetStaffRolesRequest } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { useMyProfile } from '../../account/queries.js';
import { useOpenBranches } from '../../branches/queries.js';
import {
  useCreateStaff, useResetPassword, useSetAllBranches, useSetStaffLocations, useSetStaffRoles, useStaffAction, useStaffList,
} from '../queries.js';
import { canAdministerAccounts, canChangeLocationsIn, canSetAllBranches, roleBranches, rolesToGrant } from '../rules.js';
import { StaffForm } from '../components/StaffForm.js';
import { RoleEditor } from '../components/RoleEditor.js';
import { LocationAccessPanel } from '../components/LocationAccessPanel.js';
import { ResetPasswordDialog } from '../components/ResetPasswordDialog.js';

const messageOf = (err: unknown, fallback: string) => (err as { message?: string }).message ?? fallback;

/**
 * Staff administration (#21, auth part 2). The API decides who may change
 * whom; the page offers only what the signed-in staff member may do: roles
 * below their own in the branches they manage, all-branch access for a
 * Super_Admin, account actions (create, reset, unlock, deactivate) for Admins
 * and Super_Admins, and location access in the branches they manage.
 */
export default function StaffPage() {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [editingRoles, setEditingRoles] = useState<number | null>(null);
  const [editingLocations, setEditingLocations] = useState<number | null>(null);
  const [resetting, setResetting] = useState<{ id: number; username: string } | null>(null);

  const { data: me } = useMyProfile();
  const { data, isLoading } = useStaffList({ page, pageSize });
  const branches = useOpenBranches().data?.items ?? [];
  const grantable = rolesToGrant(me);
  const reach = roleBranches(me);
  const administers = canAdministerAccounts(me);
  const allBranchesToggle = canSetAllBranches(me);

  const createMutation = useCreateStaff();
  const deactivateMutation = useStaffAction('deactivate');
  const reactivateMutation = useStaffAction('reactivate');
  const unlockMutation = useStaffAction('unlock');
  const rolesMutation = useSetStaffRoles();
  const resetMutation = useResetPassword();
  const locationsMutation = useSetStaffLocations();
  const allBranchesMutation = useSetAllBranches();

  const failed = (fallback: string) => (err: unknown) => showToast(messageOf(err, fallback), 'error');

  function create(body: CreateStaffRequest) {
    setApiError(null);
    // One request creates the account with its roles (#21): a failure part way
    // can no longer leave an account without roles.
    createMutation.mutate(body, {
      onSuccess: () => { setShowForm(false); showToast('Staff account created successfully'); },
      onError: (err) => { const msg = messageOf(err, 'Failed to create staff'); setApiError(msg); showToast(msg, 'error'); },
    });
  }
  const deactivate = (id: number) => deactivateMutation.mutate(id, {
    onSuccess: () => showToast('Staff deactivated'), onError: failed('Cannot deactivate this staff member'),
  });
  const reactivate = (id: number) => reactivateMutation.mutate(id, {
    onSuccess: () => showToast('Staff reactivated'), onError: failed('Failed to reactivate staff'),
  });
  const unlock = (id: number) => unlockMutation.mutate(id, {
    onSuccess: () => showToast('Account unlocked'), onError: failed('Failed to unlock account'),
  });
  const setRoles = (id: number, roles: SetStaffRolesRequest) => rolesMutation.mutate({ id, roles }, {
    onSuccess: () => { setEditingRoles(null); showToast('Branch & role assignments updated'); },
    onError: failed('Failed to update assignments'),
  });
  const resetPassword = (id: number, temporaryPassword: string) => resetMutation.mutate({ id, temporaryPassword }, {
    onSuccess: () => { setResetting(null); showToast('Password reset. Staff must change password on next login.'); },
    onError: failed('Failed to reset password'),
  });
  const setLocations = (id: number, locationIds: number[]) => locationsMutation.mutate({ id, locationIds }, {
    onSuccess: () => { setEditingLocations(null); showToast('Location access updated'); },
    onError: failed('Failed to update location access'),
  });
  const toggleAllBranches = (id: number, isAllBranches: boolean) => allBranchesMutation.mutate({ id, isAllBranches }, {
    onSuccess: () => showToast(isAllBranches ? 'All-branch access granted' : 'All-branch access revoked'),
    onError: failed('Failed to update all-branch access'),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Staff</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Manage staff accounts and branch assignments</p>
        </div>
        {administers && (
          <button type="button" onClick={() => { setShowForm(!showForm); setApiError(null); }}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-xs">
            {showForm ? 'Cancel' : '+ New Staff'}
          </button>
        )}
      </div>


      {resetting && (
        <ResetPasswordDialog
          username={resetting.username}
          busy={resetMutation.isPending}
          onSubmit={(temporaryPassword) => resetPassword(resetting.id, temporaryPassword)}
          onCancel={() => setResetting(null)}
        />
      )}

      {showForm && administers && (
        <StaffForm
          branches={branches}
          grantable={grantable}
          allowAllBranches={allBranchesToggle}
          busy={createMutation.isPending}
          error={apiError}
          onSubmit={create}
          onCancel={() => { setShowForm(false); setApiError(null); }}
        />
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm py-8">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading staff...
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Username</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Full Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Branch</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {data?.items.map((staff) => (
                <React.Fragment key={staff.id}>
                <tr className={`transition-colors ${editingRoles === staff.id ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{staff.username}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{staff.fullName}</td>

                  {/* Branch column */}
                  <td className="px-4 py-3">
                    {staff.isAllBranches ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                        🌐 All Branches
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {staff.roles.map((r, i) => {
                          const displayName = r.branchName ?? `Branch ${r.branchId}`;
                          return (
                            <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                              {displayName}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    {editingRoles === staff.id ? (
                      <RoleEditor
                        currentRoles={staff.roles}
                        branches={branches}
                        grantable={grantable}
                        reach={reach}
                        onSave={(roles) => setRoles(staff.id, roles)}
                        onCancel={() => setEditingRoles(null)}
                      />
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {staff.roles.map((r, i) => (
                          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                            {r.role}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        staff.isActive
                          ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                      }`}>
                        {staff.isActive ? 'Active' : 'Inactive'}
                      </span>
                      {staff.lockedUntil && new Date(staff.lockedUntil) > new Date() && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400">
                          🔒 Locked
                        </span>
                      )}
                      {staff.mustChangePassword && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400">
                          ⚠ Must reset
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    {staff.canManage && <div className="flex items-center gap-3">
                      {editingRoles !== staff.id && (
                        <button type="button" title="Edit branch & role assignments"
                          onClick={() => setEditingRoles(staff.id)}
                          className="text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                          </svg>
                        </button>
                      )}
                      {/* All Branches toggle: Super_Admin only */}
                      {allBranchesToggle && <button
                        type="button"
                        title={staff.isAllBranches ? 'Revoke all-branch access' : 'Grant all-branch access'}
                        onClick={() => toggleAllBranches(staff.id, !staff.isAllBranches)}
                        disabled={allBranchesMutation.isPending}
                        className={`transition-colors disabled:opacity-40 text-xs font-bold px-1.5 py-0.5 rounded ${
                          staff.isAllBranches
                            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/60'
                            : 'text-gray-400 dark:text-gray-500 hover:text-amber-600 dark:hover:text-amber-400'
                        }`}
                      >
                        🌐
                      </button>}
                      {/* Location access button */}
                      <button type="button" title="Manage location access"
                        onClick={() => setEditingLocations(editingLocations === staff.id ? null : staff.id)}
                        className={`transition-colors ${editingLocations === staff.id ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500 hover:text-indigo-600 dark:hover:text-indigo-400'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </button>
                      {/* Unlock button — shown when account is locked */}
                      {administers && staff.lockedUntil && new Date(staff.lockedUntil) > new Date() && (
                        <button type="button" title="Unlock account"
                          onClick={() => unlock(staff.id)}
                          disabled={unlockMutation.isPending}
                          className="text-gray-400 dark:text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 transition-colors disabled:opacity-40">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                          </svg>
                        </button>
                      )}
                      {/* Reset password button */}
                      {administers && <button type="button" title="Reset password (staff must change on next login)"
                        onClick={() => setResetting({ id: staff.id, username: staff.username })}
                        disabled={resetMutation.isPending}
                        className="text-gray-400 dark:text-gray-500 hover:text-orange-600 dark:hover:text-orange-400 transition-colors disabled:opacity-40">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                        </svg>
                      </button>}
                      {administers && (staff.isActive ? (
                        <button type="button" title="Deactivate staff"
                          onClick={() => deactivate(staff.id)}
                          disabled={deactivateMutation.isPending}
                          className="text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-40">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                        </button>
                      ) : (
                        <button type="button" title="Reactivate staff"
                          onClick={() => reactivate(staff.id)}
                          disabled={reactivateMutation.isPending}
                          className="text-gray-400 dark:text-gray-500 hover:text-green-600 dark:hover:text-green-400 transition-colors disabled:opacity-40">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>
                      ))}
                    </div>}
                  </td>
                </tr>
                {editingLocations === staff.id && (
                  <tr className="bg-indigo-50 dark:bg-indigo-950/20">
                    <td colSpan={6} className="px-4 py-3">
                      <LocationAccessPanel
                        staffId={staff.id}
                        staffUsername={staff.username}
                        branchIds={staff.roles.map(r => r.branchId)}
                        canChangeIn={(branchId) => canChangeLocationsIn(me, branchId)}
                        onSave={(locationIds) => setLocations(staff.id, locationIds)}
                        onClose={() => setEditingLocations(null)}
                        isSaving={locationsMutation.isPending}
                      />
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {(!data?.items || data.items.length === 0) && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No staff found</p>
          )}
          {data && data.total > 0 && (
            <Pagination
              page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
              onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
              itemLabel="staff member"
            />
          )}
        </div>
      )}
    </div>
  );
}
