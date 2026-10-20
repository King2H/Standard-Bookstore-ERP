import { useState } from 'react';
import type { BankAccount } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { useAccounts, useSetAccountActive } from '../queries.js';
import { canManageAccounts } from '../rules.js';
import { AccountForm } from './AccountForm.js';

const TH = 'text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400';

/**
 * The branch's accounts; a row opens its reconciliation. Deactivating is
 * confirmed in the app's dialog (owner decision 2a), as bank payments stop
 * offering the account at once.
 */
export function AccountList({ branchId, selectedId, onSelect }: {
  branchId: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<BankAccount | null>(null);
  const { data, isLoading, error } = useAccounts(branchId, page, pageSize);
  // The API mounts these endpoints only with FEATURE_BANK_ACCOUNTS=true.
  const moduleOff = (error as { status?: number } | null)?.status === 404;
  const setActive = useSetAccountActive(branchId);
  const manage = canManageAccounts(me);

  function changeActive(acct: BankAccount, active: boolean) {
    setActive.mutate({ id: acct.id, active }, {
      onSuccess: () => { setDeactivating(null); showToast(active ? 'Bank account reactivated' : 'Bank account deactivated'); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Accounts</h2>
        {manage && !moduleOff && (
          <button onClick={() => setEditing('new')}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">+ New Account</button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">Loading...</p>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
              <tr><th className={TH}>Account</th><th className={TH}>Number</th><th className={TH}>Currency</th><th className={TH}>Status</th><th className={TH}>Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {(data?.items ?? []).map((acct) => (
                <tr key={acct.id} onClick={() => onSelect(acct.id === selectedId ? null : acct.id)}
                  className={`cursor-pointer transition-colors ${selectedId === acct.id ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-white">{acct.accountName}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500">{acct.bankName}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
                    {acct.accountNumberMasked}
                    {acct.ibanMasked && <div className="text-gray-400 dark:text-gray-500">{acct.ibanMasked}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{acct.currency}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${acct.isActive ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>
                      {acct.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {manage && (
                      <span className="inline-flex gap-3">
                        <button onClick={() => setEditing(acct)} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 text-xs font-medium transition-colors">Edit</button>
                        {acct.isActive ? (
                          <button onClick={() => setDeactivating(acct)} className="text-red-500 dark:text-red-400 hover:text-red-700 text-xs font-medium transition-colors">Deactivate</button>
                        ) : (
                          <button onClick={() => changeActive(acct, true)} disabled={setActive.isPending}
                            className="text-green-600 dark:text-green-400 hover:text-green-800 text-xs font-medium disabled:opacity-50 transition-colors">Reactivate</button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(!data?.items || data.items.length === 0) && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">
              {moduleOff ? 'The Bank Accounts module is switched off.' : 'No bank accounts found'}
            </p>
          )}
          {data && data.total > DEFAULT_PAGE_SIZE && (
            <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
              onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="account" />
          )}
        </div>
      )}

      {editing && <AccountForm branchId={branchId} account={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
      {deactivating && (
        <ActionDialog
          title="Deactivate Bank Account"
          message={`Deactivate ${deactivating.accountName} (${deactivating.accountNumberMasked})? Bank payments stop offering it at once; its movements and statement lines are kept.`}
          confirmLabel="Deactivate"
          tone="red"
          busy={setActive.isPending}
          onConfirm={() => changeActive(deactivating, false)}
          onCancel={() => setDeactivating(null)}
        />
      )}
    </div>
  );
}
