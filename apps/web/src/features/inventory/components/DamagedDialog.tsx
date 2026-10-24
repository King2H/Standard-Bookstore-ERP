import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money, type StockLevel } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useDamagedStock } from '../queries.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/** What `quantity` of the damaged copies are worth, as the API takes them: the last ones take what is left. */
function shareOf(row: StockLevel, quantity: number): Money {
  const value = Money.of(row.damagedValue);
  if (quantity >= row.damaged) return value;
  return value.times(quantity).dividedBy(row.damaged).round(2);
}

/**
 * Damaged copies leave by hand (#168): written off, their value a loss, or
 * put back for sale after repair at the cost they were kept at. Either way
 * with a reason, recorded in the history and the audit log.
 */
export function DamagedDialog({ row, onClose }: { row: StockLevel; onClose: () => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const save = useDamagedStock();
  const Schema = z.object({
    action: z.enum(['write_off', 'repair']),
    quantity: z.string().trim()
      .refine((v) => /^\d+$/.test(v) && Number(v) >= 1, 'Enter a whole number of copies')
      .refine((v) => !/^\d+$/.test(v) || Number(v) <= row.damaged, `At most ${row.damaged}`),
    reason: z.string().trim().min(1, 'A reason is required').max(500, 'At most 500 characters'),
  });
  const { register, handleSubmit, watch, formState: { errors } } = useForm<z.infer<typeof Schema>>({
    resolver: zodResolver(Schema),
    defaultValues: { action: 'write_off', quantity: '1', reason: '' },
  });
  const action = watch('action');
  const typed = watch('quantity').trim();
  const quantity = /^\d+$/.test(typed) ? Number(typed) : 0;
  const value = quantity >= 1 && quantity <= row.damaged ? shareOf(row, quantity) : null;

  const onSubmit = handleSubmit((v) => {
    save.mutate(
      { action: v.action, body: { bookId: row.bookId, locationId: row.locationId, quantity: Number(v.quantity), reason: v.reason.trim(), version: row.version } },
      {
        onSuccess: () => { showToast(v.action === 'write_off' ? 'Damaged copies written off' : 'Copies back for sale', 'success'); onClose(); },
        onError: (e: Error) => showToast(e.message, 'error'),
      },
    );
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="damaged-dialog-title" onSubmit={onSubmit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="damaged-dialog-title" className="text-base font-semibold text-gray-900 dark:text-white">Damaged: {row.bookTitle}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {`${row.damaged} damaged ${row.damaged === 1 ? 'copy' : 'copies'} at ${row.locationName}, kept apart at ${currency} ${Money.of(row.damagedValue).toFixed(2)}.`}
        </p>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">What happens to them</legend>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="radio" value="write_off" {...register('action')} /> Write off: they leave, their value is a loss
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="radio" value="repair" {...register('action')} /> Repaired: back for sale at their cost
          </label>
        </fieldset>
        <div>
          <label htmlFor="damaged-quantity" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Copies</label>
          <input id="damaged-quantity" inputMode="numeric" {...register('quantity')} aria-invalid={errors.quantity ? true : undefined} className={INPUT} />
          {errors.quantity
            ? <p role="alert" className="text-xs mt-1 text-red-500">{errors.quantity.message}</p>
            : value && <p className="text-xs mt-1 text-gray-400">{`${action === 'write_off' ? 'Loss' : 'Back in stock at'}: ${currency} ${value.toFixed(2)}`}</p>}
        </div>
        <div>
          <label htmlFor="damaged-reason" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Reason</label>
          <textarea id="damaged-reason" rows={3} {...register('reason')} aria-invalid={errors.reason ? true : undefined} className={`${INPUT} resize-none`} />
          {errors.reason && <p role="alert" className="text-xs mt-1 text-red-500">{errors.reason.message}</p>}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={save.isPending}
            className={`px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 transition-colors ${action === 'write_off' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
            {action === 'write_off' ? 'Write off' : 'Back for sale'}
          </button>
        </div>
      </form>
    </div>
  );
}
