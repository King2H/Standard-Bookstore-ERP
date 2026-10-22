import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { StockLevel } from '@bms/shared';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useStockIn } from '../queries.js';
import { STOCK_IN_REFERENCES } from '../rules.js';
import { StockPicker } from './StockPicker.js';
import { INPUT, LABEL, Messages, isPositiveWhole, isUnitCost, useStockChange } from './stockChange.js';

/**
 * The form's fields, checked with the rules of the API's stock-in contract:
 * stock comes in at what it cost, a customer's return may leave it out (#163).
 */
const StockInFormSchema = z.object({
  quantity: z.string().trim().refine(isPositiveWhole, 'Enter a positive quantity'),
  unitCost: z.string().trim().refine((v) => v === '' || isUnitCost(v), 'A unit cost is an amount above 0, e.g. 12.50'),
  referenceType: z.union([z.literal(''), z.enum(['return', 'manual', 'initial_stock'])]),
  referenceId: z.string().trim().refine((v) => v === '' || isPositiveWhole(v), 'A reference ID is a whole number'),
  notes: z.string().max(500, 'Notes can be at most 500 characters'),
}).refine((v) => v.unitCost !== '' || v.referenceType === 'return', {
  path: ['unitCost'], message: 'Enter what one copy cost: stock is valued at its cost',
});
type StockInFormValues = z.infer<typeof StockInFormSchema>;

/** Stock received by hand at one location. */
export function StockInTab({ initialRow = null }: { initialRow?: StockLevel | null }) {
  const { chosen, setChosen, choose, error, setError, success, setSuccess, refused } = useStockChange(initialRow);
  const currency = useCurrency();
  const save = useStockIn();
  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm<StockInFormValues>({
    resolver: zodResolver(StockInFormSchema),
    defaultValues: { quantity: '', unitCost: '', referenceType: '', referenceId: '', notes: '' },
  });
  const quantity = watch('quantity');
  const referenceType = watch('referenceType');
  const problem = errors.quantity?.message ?? errors.unitCost?.message ?? errors.referenceId?.message ?? errors.notes?.message;

  function submit(v: StockInFormValues) {
    if (!chosen) { setError('Select a book and location first'); return; }
    setError(''); setSuccess('');
    save.mutate({
      bookId: chosen.bookId,
      locationId: chosen.locationId,
      quantity: Number(v.quantity),
      unitCost: v.unitCost || undefined,
      version: chosen.version,
      referenceType: v.referenceType || undefined,
      referenceId: v.referenceId ? Number(v.referenceId) : undefined,
      notes: v.notes || undefined,
    }, {
      onSuccess: (level) => {
        setSuccess(`Stock in recorded. New quantity: ${level.quantity}`);
        setChosen(level);
        reset({ quantity: '', unitCost: '', referenceType: v.referenceType, referenceId: '', notes: '' });
      },
      onError: refused,
    });
  }

  return (
    <div className="flex h-full">
      <StockPicker chosen={chosen} onChoose={choose} accent="emerald" />

      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-emerald-500 text-xl">⬇️</span>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Stock In</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Record incoming inventory by hand — customer returns, opening stock, or manual additions. Purchase orders are received in Procurement.</p>

          {chosen ? (
            <div className="mb-5 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm">
              <div className="font-medium text-emerald-900 dark:text-emerald-200">{chosen.bookTitle}</div>
              <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">{chosen.locationName} · Current qty: <strong>{chosen.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a book and location from the left panel
            </div>
          )}

          <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
            <Messages error={problem ?? error} success={success} />

            <div>
              <label htmlFor="stock-in-quantity" className={LABEL}>Quantity *</label>
              <input id="stock-in-quantity" type="number" {...register('quantity')} min="1" placeholder="Units received"
                aria-invalid={errors.quantity ? true : undefined} className={INPUT} />
              {chosen && isPositiveWhole(quantity.trim()) && (
                <p className="text-xs text-gray-400 mt-1">New quantity: <strong>{chosen.quantity + Number(quantity)}</strong></p>
              )}
            </div>

            <div>
              <label htmlFor="stock-in-unit-cost" className={LABEL}>{`Unit Cost (${currency})${referenceType === 'return' ? '' : ' *'}`}</label>
              <input id="stock-in-unit-cost" type="text" inputMode="decimal" {...register('unitCost')}
                placeholder={referenceType === 'return' ? 'Left empty: the book\'s last known cost' : 'What one copy cost'}
                aria-invalid={errors.unitCost ? true : undefined} className={INPUT} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="stock-in-reference-type" className={LABEL}>Reference Type</label>
                <select id="stock-in-reference-type" {...register('referenceType', { onChange: () => setValue('referenceId', '') })} className={INPUT}>
                  <option value="">— None —</option>
                  {STOCK_IN_REFERENCES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="stock-in-reference-id" className={LABEL}>Reference ID</label>
                <input id="stock-in-reference-id" type="text" inputMode="numeric" {...register('referenceId')}
                  placeholder={referenceType ? 'Reference number' : '—'} disabled={!referenceType}
                  aria-invalid={errors.referenceId ? true : undefined} className={`${INPUT} disabled:opacity-40`} />
              </div>
            </div>

            <div>
              <label htmlFor="stock-in-notes" className={LABEL}>Notes (optional)</label>
              <textarea id="stock-in-notes" {...register('notes')} rows={2} placeholder="Additional context…" className={`${INPUT} resize-none`} />
            </div>

            <button type="submit" disabled={save.isPending || !chosen}
              className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {save.isPending ? 'Recording…' : '⬇️ Record Stock In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
