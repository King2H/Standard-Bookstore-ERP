import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { AdjustmentReason } from '@bms/shared';
import { useEffectiveSetting } from '../../settings/queries.js';
import { useAdjustStock } from '../queries.js';
import { ADJUSTMENT_DIRECTION } from '../rules.js';
import { StockPicker } from './StockPicker.js';
import { INPUT, LABEL, Messages, isPositiveWhole, useStockChange } from './stockChange.js';

/** The form's fields, checked with the rules of the API's adjustment contract. */
const AdjustFormSchema = z.object({
  amount: z.string().trim().refine(isPositiveWhole, 'Enter a non-zero quantity'),
  reasonCode: z.enum(['correction', 'damage', 'loss', 'return']),
  notes: z.string().max(500, 'Notes can be at most 500 characters'),
});
type AdjustFormValues = z.infer<typeof AdjustFormSchema>;

/** A manual stock change with a reason code. */
export function AdjustTab() {
  const { chosen, setChosen, choose, error, setError, success, setSuccess, refused } = useStockChange(null);
  const save = useAdjustStock();
  // Below zero only when the branch allows negative stock, as the API decides (was: not checked).
  const allowNegative = useEffectiveSetting('allow_negative_stock') === true;
  const [removing, setRemoving] = useState(false);
  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<AdjustFormValues>({
    resolver: zodResolver(AdjustFormSchema),
    defaultValues: { amount: '', reasonCode: 'correction', notes: '' },
  });
  const amount = watch('amount');
  const reasonCode = watch('reasonCode');
  const fixed = ADJUSTMENT_DIRECTION[reasonCode];
  const remove = fixed ? fixed === 'remove' : removing;
  const problem = errors.amount?.message ?? errors.notes?.message;

  const delta = isPositiveWhole(amount.trim()) ? (remove ? -1 : 1) * Number(amount) : null;
  const after = chosen && delta !== null ? chosen.quantity + delta : null;
  const goesNegative = after !== null && after < 0;
  const blocked = goesNegative && !allowNegative;

  function submit(v: AdjustFormValues) {
    if (!chosen) { setError('Select a book and location first'); return; }
    setError(''); setSuccess('');
    save.mutate({
      bookId: chosen.bookId,
      locationId: chosen.locationId,
      delta: (remove ? -1 : 1) * Number(v.amount),
      reasonCode: v.reasonCode as AdjustmentReason,
      notes: v.notes || undefined,
      version: chosen.version,
    }, {
      onSuccess: (level) => {
        setSuccess(`Done. New quantity: ${level.quantity}`);
        setChosen(level);
        reset({ amount: '', reasonCode: v.reasonCode, notes: '' });
      },
      onError: refused,
    });
  }

  return (
    <div className="flex h-full">
      <StockPicker chosen={chosen} onChoose={choose} accent="blue" />

      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Stock Adjustment</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Record a manual stock change with a reason code.</p>

          {chosen ? (
            <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <div className="font-medium text-blue-900 dark:text-blue-200">{chosen.bookTitle}</div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">{chosen.locationName} · Current qty: <strong>{chosen.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a book and location from the left panel
            </div>
          )}

          <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
            <Messages error={problem ?? error} success={success} />

            <div>
              <label htmlFor="adjust-amount" className={LABEL}>Quantity Change *</label>
              <div className="flex gap-2">
                <button type="button" disabled={fixed !== null} onClick={() => setRemoving(r => !r)}
                  className={`px-3 py-2 text-sm border rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${remove ? 'bg-red-100 border-red-300 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-400' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                  {remove ? '− Remove' : '+ Add'}
                </button>
                <input id="adjust-amount" type="number" {...register('amount')} min="1" placeholder="0"
                  aria-invalid={errors.amount ? true : undefined} className={`flex-1 ${INPUT.replace('w-full ', '')}`} />
              </div>
              {after !== null && (
                <p className={`text-xs mt-1 ${blocked ? 'text-red-500' : goesNegative ? 'text-amber-500' : 'text-gray-400'}`}>
                  {blocked
                    ? `⚠ Leaves stock below zero (${after}); negative stock is not allowed`
                    : goesNegative
                    ? `⚠ Leaves stock below zero (${after}); negative stock is allowed`
                    : <>New quantity: <strong>{after}</strong></>}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="adjust-reason" className={LABEL}>Reason *</label>
              <select id="adjust-reason" {...register('reasonCode')} className={INPUT}>
                <option value="correction">Correction (count discrepancy)</option>
                <option value="damage">Damage</option>
                <option value="loss">Loss / Theft</option>
                <option value="return">Customer Return</option>
              </select>
            </div>

            <div>
              <label htmlFor="adjust-notes" className={LABEL}>Notes (optional)</label>
              <textarea id="adjust-notes" {...register('notes')} rows={2} placeholder="Additional context…" className={`${INPUT} resize-none`} />
            </div>

            <button type="submit" disabled={save.isPending || !chosen || blocked}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {save.isPending ? 'Saving…' : 'Record Adjustment'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
