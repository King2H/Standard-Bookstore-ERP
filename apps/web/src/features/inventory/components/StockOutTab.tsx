import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { StockLevel } from '@bms/shared';
import { useEffectiveSetting } from '../../settings/queries.js';
import { useStockOut } from '../queries.js';
import { STOCK_OUT_REFERENCES } from '../rules.js';
import { StockPicker } from './StockPicker.js';
import { INPUT, LABEL, Messages, isPositiveWhole, useStockChange } from './stockChange.js';

/** The form's fields, checked with the rules of the API's stock-out contract. */
const StockOutFormSchema = z.object({
  quantity: z.string().trim().refine(isPositiveWhole, 'Enter a positive quantity'),
  referenceType: z.union([z.literal(''), z.literal('manual')]),
  referenceId: z.string().trim().refine((v) => v === '' || isPositiveWhole(v), 'A reference ID is a whole number'),
  notes: z.string().max(500, 'Notes can be at most 500 characters'),
});
type StockOutFormValues = z.infer<typeof StockOutFormSchema>;

/** Stock removed by hand at one location; sales take stock out through POS and orders. */
export function StockOutTab({ initialRow = null }: { initialRow?: StockLevel | null }) {
  const { chosen, setChosen, choose, error, setError, success, setSuccess, refused } = useStockChange(initialRow);
  const save = useStockOut();
  // Below zero only when the shop allows negative stock, as the API decides (was: always blocked).
  const allowNegative = useEffectiveSetting('allow_negative_stock') === true;
  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<StockOutFormValues>({
    resolver: zodResolver(StockOutFormSchema),
    defaultValues: { quantity: '', referenceType: '', referenceId: '', notes: '' },
  });
  const quantity = watch('quantity');
  const problem = errors.quantity?.message ?? errors.referenceId?.message ?? errors.notes?.message;

  const qty = isPositiveWhole(quantity.trim()) ? Number(quantity) : null;
  const after = chosen && qty !== null ? chosen.quantity - qty : null;
  const goesNegative = after !== null && after < 0;
  const blocked = goesNegative && !allowNegative;
  const goesLow = after !== null && !goesNegative && chosen !== null && after <= chosen.reorderPoint;

  function submit(v: StockOutFormValues) {
    if (!chosen) { setError('Select a book and location first'); return; }
    setError(''); setSuccess('');
    save.mutate({
      bookId: chosen.bookId,
      locationId: chosen.locationId,
      quantity: Number(v.quantity),
      version: chosen.version,
      referenceType: v.referenceType || undefined,
      referenceId: v.referenceId ? Number(v.referenceId) : undefined,
      notes: v.notes || undefined,
    }, {
      onSuccess: (level) => {
        setSuccess(`Stock out recorded. New quantity: ${level.quantity}`);
        setChosen(level);
        reset({ quantity: '', referenceType: v.referenceType, referenceId: '', notes: '' });
      },
      onError: refused,
    });
  }

  return (
    <div className="flex h-full">
      <StockPicker chosen={chosen} onChoose={choose} accent="blue" markLow />

      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-blue-500 text-xl">⬆️</span>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Stock Out</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Record manual removals; sales use POS and Orders, damage uses Adjust.</p>

          {chosen ? (
            <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <div className="font-medium text-blue-900 dark:text-blue-200">{chosen.bookTitle}</div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">{chosen.locationName} · Available: <strong>{chosen.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a book and location from the left panel
            </div>
          )}

          <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
            <Messages error={problem ?? error} success={success} />

            <div>
              <label htmlFor="stock-out-quantity" className={LABEL}>Quantity *</label>
              <input id="stock-out-quantity" type="number" {...register('quantity')} min="1" placeholder="Units to remove"
                aria-invalid={errors.quantity ? true : undefined} className={INPUT} />
              {chosen && after !== null && (
                <p className={`text-xs mt-1 ${blocked ? 'text-red-500' : goesNegative || goesLow ? 'text-amber-500' : 'text-gray-400'}`}>
                  {blocked
                    ? `⚠ Exceeds available stock (${chosen.quantity})`
                    : goesNegative
                    ? `⚠ Leaves stock below zero (${after}); negative stock is allowed`
                    : goesLow
                    ? `⚠ Will trigger low-stock alert (${after} remaining)`
                    : `New quantity: ${after}`}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="stock-out-reference-type" className={LABEL}>Reference Type</label>
                <select id="stock-out-reference-type" {...register('referenceType')} className={INPUT}>
                  <option value="">— None —</option>
                  {STOCK_OUT_REFERENCES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="stock-out-reference-id" className={LABEL}>Reference ID</label>
                <input id="stock-out-reference-id" type="number" {...register('referenceId')} min="1" placeholder="e.g. 1024"
                  aria-invalid={errors.referenceId ? true : undefined} className={INPUT} />
              </div>
            </div>

            <div>
              <label htmlFor="stock-out-notes" className={LABEL}>Notes (optional)</label>
              <textarea id="stock-out-notes" {...register('notes')} rows={2} placeholder="Additional context…" className={`${INPUT} resize-none`} />
            </div>

            <button type="submit" disabled={save.isPending || !chosen || blocked}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {save.isPending ? 'Recording…' : '⬆️ Record Stock Out'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
