import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { getCurrentBranchId } from '../../../lib/api.js';
import { useEveryLocation } from '../../locations/queries.js';
import { useTransferStock } from '../queries.js';
import { StockPicker } from './StockPicker.js';
import { INPUT, LABEL, Messages, isPositiveWhole, useStockChange } from './stockChange.js';

/** The form's fields, checked with the rules of the API's transfer contract. */
const TransferFormSchema = z.object({
  toLocationId: z.string().min(1, 'Select a destination location'),
  quantity: z.string().trim().refine(isPositiveWhole, 'Enter a positive quantity'),
});
type TransferFormValues = z.infer<typeof TransferFormSchema>;

/**
 * Stock moved between two locations of the session's branch. Staff limited to
 * some locations send from theirs to any location of the branch (#72).
 */
export function TransferTab() {
  const { chosen, setChosen, choose, error, setError, success, setSuccess, refused } = useStockChange(null);
  const save = useTransferStock();
  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<TransferFormValues>({
    resolver: zodResolver(TransferFormSchema),
    defaultValues: { toLocationId: '', quantity: '' },
  });
  // Every location of the branch (was: only the staff member's own, though the API accepts any).
  const { data: locations } = useEveryLocation(chosen?.branchId ?? getCurrentBranchId());
  const destinations = (locations?.items ?? []).filter(l => l.id !== chosen?.locationId);
  const toLocationId = watch('toLocationId');
  const quantity = watch('quantity');
  const problem = errors.toLocationId?.message ?? errors.quantity?.message;

  // A transfer never takes stock below zero (was: not checked, then refused).
  const available = chosen ? Math.max(0, chosen.quantity) : 0;
  const exceeds = chosen !== null && isPositiveWhole(quantity.trim()) && Number(quantity) > available;

  function submit(v: TransferFormValues) {
    if (!chosen) { setError('Select a source book and location'); return; }
    setError(''); setSuccess('');
    const qty = Number(v.quantity);
    save.mutate({
      bookId: chosen.bookId,
      fromLocationId: chosen.locationId,
      toLocationId: Number(v.toLocationId),
      quantity: qty,
      fromVersion: chosen.version,
    }, {
      onSuccess: ({ from, to }) => {
        setSuccess(`Transferred ${qty} units. From: ${from.quantity} remaining. To: ${to.quantity} now.`);
        setChosen(from);
        reset({ toLocationId: v.toLocationId, quantity: '' });
      },
      onError: refused,
    });
  }

  return (
    <div className="flex h-full">
      <StockPicker chosen={chosen} onChoose={choose} accent="blue" title="Source (Book + Location)" />

      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Stock Transfer</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Move stock between locations within this branch.</p>

          {chosen ? (
            <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <div className="font-medium text-blue-900 dark:text-blue-200">{chosen.bookTitle}</div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">From: {chosen.locationName} · Available: <strong>{chosen.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a source book and location
            </div>
          )}

          <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
            <Messages error={problem ?? error} success={success} />

            <div>
              <label htmlFor="transfer-to" className={LABEL}>Destination Location *</label>
              <select id="transfer-to" {...register('toLocationId')} className={INPUT}>
                <option value="">— Select destination —</option>
                {destinations.map(l => (
                  <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="transfer-quantity" className={LABEL}>Quantity *</label>
              <input id="transfer-quantity" type="number" {...register('quantity')} min="1" placeholder="Units to transfer"
                aria-invalid={errors.quantity || exceeds ? true : undefined} className={INPUT} />
              {exceeds && <p className="text-xs mt-1 text-red-500">⚠ Exceeds available stock ({available})</p>}
            </div>

            <button type="submit" disabled={save.isPending || !chosen || !toLocationId || exceeds}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {save.isPending ? 'Transferring…' : 'Transfer Stock'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
