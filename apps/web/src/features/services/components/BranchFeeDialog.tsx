import { useState } from 'react';
import type { Service } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useBranchFee } from '../queries.js';
import { isFee } from '../rules.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/** The session branch's own fee for a service (owner decision 2a), or back to the shop's. */
export function BranchFeeDialog({ service, onClose }: { service: Service; onClose: () => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const save = useBranchFee();
  const [fee, setFee] = useState(service.branchFee?.toFixed(2) ?? '');
  const [error, setError] = useState('');

  function run(value: string | null) {
    if (value !== null && !isFee(value)) { setError('An amount above 0, e.g. 250.00'); return; }
    save.mutate({ id: service.id, fee: value?.trim() ?? null }, {
      onSuccess: () => { showToast(value === null ? 'Back to the shop fee' : 'Branch fee saved', 'success'); onClose(); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="branch-fee-title" noValidate onSubmit={(e) => { e.preventDefault(); run(fee); }}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="branch-fee-title" className="text-base font-semibold text-gray-900 dark:text-white">Branch fee: {service.name}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">{`The shop's fee is ${currency} ${service.fee.toFixed(2)}. This branch may charge its own; the standard cost stays the shop's.`}</p>
        <div>
          <label htmlFor="branch-fee" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{`This branch's fee (${currency})`}</label>
          <input id="branch-fee" inputMode="decimal" autoFocus value={fee} onChange={(e) => { setFee(e.target.value); setError(''); }}
            aria-invalid={error ? true : undefined} className={INPUT} />
          {error && <p role="alert" className="text-xs mt-1 text-red-500">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          {service.branchFee !== null && (
            <button type="button" disabled={save.isPending} onClick={() => run(null)}
              className="mr-auto px-3 py-2 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Use the shop fee</button>
          )}
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={save.isPending} className="px-4 py-2 text-sm rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50">Save</button>
        </div>
      </form>
    </div>
  );
}
