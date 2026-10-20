import { useState } from 'react';
import { useMyProfile } from '../../account/queries.js';
import { useOpenBranches } from '../../branches/queries.js';
import { AccountList } from '../components/AccountList.js';
import { Reconciliation } from '../components/Reconciliation.js';

const SELECT = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 transition-colors max-w-xs';

/**
 * Bank accounts of a branch and their reconciliation. It opens on the session
 * branch; only staff with access to all branches pick another, as the API
 * allows no one else (was: every branch offered, and a 403 for the others).
 */
export default function BankAccountsPage() {
  const { data: me } = useMyProfile();
  const [picked, setPicked] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const allBranches = !!me?.isAllBranches;
  const { data: branches } = useOpenBranches();
  const branchId = picked ?? me?.currentBranchId ?? null;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Bank Accounts</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Manage branch bank accounts and reconciliation</p>
        </div>
      </div>

      {allBranches && (
        <div className="mb-6">
          <label htmlFor="bank-branch" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Branch</label>
          <select id="bank-branch" value={branchId ?? ''} className={SELECT}
            onChange={(e) => { setPicked(Number(e.target.value)); setAccountId(null); }}>
            {(branches?.items ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}

      {branchId !== null && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <AccountList key={branchId} branchId={branchId} selectedId={accountId} onSelect={setAccountId} />
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Reconciliation</h2>
            {accountId === null ? (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center shadow-xs">
                <p className="text-sm text-gray-400 dark:text-gray-500">Select an account to reconcile its statement</p>
              </div>
            ) : (
              <Reconciliation key={accountId} branchId={branchId} accountId={accountId} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
