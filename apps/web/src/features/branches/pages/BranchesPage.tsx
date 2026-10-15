import { useState } from 'react';
import type { Branch } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { useMyProfile } from '../../account/queries.js';
import { useBranchAction, useBranches, useCreateBranch, useDeleteBranch } from '../queries.js';
import { canManageBranches } from '../rules.js';
import { BranchForm, type BranchFormValues } from '../components/BranchForm.js';

const messageOf = (err: unknown, fallback: string) => (err as { message?: string }).message ?? fallback;

export default function BranchesPage() {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const { data: me } = useMyProfile();
  const { data, isLoading } = useBranches({ page, pageSize });
  const createMutation = useCreateBranch();
  const deleteMutation = useDeleteBranch();
  const deactivateMutation = useBranchAction('deactivate');
  const reactivateMutation = useBranchAction('reactivate');

  // Only head office opens, closes, creates and deletes branches (Super_Admin,
  // or Admin with access to all branches), as the API decides.
  const canManage = canManageBranches(me);

  function create(values: BranchFormValues) {
    setApiError(null);
    createMutation.mutate(values, {
      onSuccess: () => { setShowForm(false); showToast('Branch created successfully'); },
      onError: (err) => {
        const msg = (err as { code?: string }).code === 'DUPLICATE_BRANCH_NAME'
          ? 'A branch with this name already exists'
          : messageOf(err, 'Failed to create branch');
        setApiError(msg);
        showToast(msg, 'error');
      },
    });
  }

  function remove(id: number) {
    deleteMutation.mutate(id, {
      onSuccess: () => { showToast('Branch deleted'); setDeleteConfirmId(null); },
      onError: (err) => { showToast(messageOf(err, 'Cannot delete branch — it may have associated data'), 'error'); setDeleteConfirmId(null); },
    });
  }

  const deactivate = (b: Branch) => deactivateMutation.mutate(b.id, {
    onSuccess: () => showToast('Branch deactivated'),
    onError: (err) => showToast(messageOf(err, 'Failed to deactivate branch'), 'error'),
  });
  const reactivate = (b: Branch) => reactivateMutation.mutate(b.id, {
    onSuccess: () => showToast('Branch reactivated'),
    onError: (err) => showToast(messageOf(err, 'Failed to reactivate branch'), 'error'),
  });

  return (
    <div className="p-6">
      {/* Delete confirmation dialog */}
      {deleteConfirmId !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">Delete Branch?</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">This action cannot be undone. Branches with associated data (staff, inventory, transactions) cannot be deleted.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteConfirmId(null)} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
              <button onClick={() => remove(deleteConfirmId)} disabled={deleteMutation.isPending} className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 transition-colors">{deleteMutation.isPending ? 'Deleting...' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Branches</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Manage store locations</p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => { setShowForm(!showForm); setApiError(null); }}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-xs"
          >
            {showForm ? 'Cancel' : '+ New Branch'}
          </button>
        )}
      </div>

      {showForm && (
        <BranchForm
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
          Loading branches...
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Address</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                {canManage && <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {data?.items.map((branch) => (
                <tr key={branch.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{branch.name}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{branch.address}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      branch.isActive
                        ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                    }`}>
                      {branch.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                      {branch.isActive ? (
                        <button
                          type="button"
                          onClick={() => deactivate(branch)}
                          disabled={deactivateMutation.isPending}
                          className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-xs font-medium disabled:opacity-50 transition-colors"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => reactivate(branch)}
                          disabled={reactivateMutation.isPending}
                          className="text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 text-xs font-medium disabled:opacity-50 transition-colors"
                        >
                          Reactivate
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(branch.id)}
                        className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 text-xs font-medium transition-colors ml-1"
                      >
                        Delete
                      </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {(!data?.items || data.items.length === 0) && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No branches found</p>
          )}
          {data && data.total > 0 && (
            <Pagination
              page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
              onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
              itemLabel="branch" itemPlural="branches"
            />
          )}
        </div>
      )}
    </div>
  );
}
