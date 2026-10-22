import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money, type StockLevel } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useRevalueStock } from '../queries.js';
import { isUnitCost } from './stockChange.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * Sets the average cost of the copies on hand, with the reason (#163): stock
 * that came in with no cost, or a cost found to be wrong. No copies move; the
 * value before and after is recorded in the audit log.
 */
export function RevalueDialog({ row, onClose }: { row: StockLevel; onClose: () => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const save = useRevalueStock();
  const current = Money.of(row.averageCost);
  const Schema = z.object({
    unitCost: z.string().trim()
      .refine(isUnitCost, 'Enter an amount above 0, e.g. 12.50')
      .refine((v) => !isUnitCost(v) || !Money.of(v).equals(current), 'The copies already have this cost'),
    reason: z.string().trim().min(1, 'A reason is required').max(500, 'At most 500 characters'),
  });
  const { register, handleSubmit, watch, formState: { errors } } = useForm<z.infer<typeof Schema>>({
    resolver: zodResolver(Schema),
    defaultValues: { unitCost: '', reason: '' },
  });
  const typed = watch('unitCost').trim();
  const copies = `${row.quantity} ${row.quantity === 1 ? 'copy' : 'copies'}`;

  const onSubmit = handleSubmit((v) => {
    save.mutate({ bookId: row.bookId, locationId: row.locationId, unitCost: v.unitCost.trim(), reason: v.reason.trim(), version: row.version }, {
      onSuccess: () => { showToast('Stock revalued', 'success'); onClose(); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="revalue-dialog-title" onSubmit={onSubmit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="revalue-dialog-title" className="text-base font-semibold text-gray-900 dark:text-white">Revalue: {row.bookTitle}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {current.isZero()
            ? `The ${copies} at ${row.locationName} have no cost, so they add nothing to the inventory value.`
            : `The ${copies} at ${row.locationName} are valued at ${currency} ${current.toFixed(2)} each, ${currency} ${current.times(row.quantity).toFixed(2)} in all.`}
          {' '}No copies move; the change and its reason are recorded in the audit log.
        </p>
        <div>
          <label htmlFor="revalue-unit-cost" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{`New cost of one copy (${currency})`}</label>
          <input id="revalue-unit-cost" inputMode="decimal" autoFocus {...register('unitCost')} aria-invalid={errors.unitCost ? true : undefined} className={INPUT} />
          {errors.unitCost
            ? <p role="alert" className="text-xs mt-1 text-red-500">{errors.unitCost.message}</p>
            : isUnitCost(typed) && <p className="text-xs mt-1 text-gray-400">{`New value: ${currency} ${Money.of(typed).times(row.quantity).toFixed(2)}`}</p>}
        </div>
        <div>
          <label htmlFor="revalue-reason" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Where does this cost come from?</label>
          <textarea id="revalue-reason" rows={3} {...register('reason')} aria-invalid={errors.reason ? true : undefined} className={`${INPUT} resize-none`} />
          {errors.reason && <p role="alert" className="text-xs mt-1 text-red-500">{errors.reason.message}</p>}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={save.isPending} className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 transition-colors bg-blue-600 hover:bg-blue-700">Revalue</button>
        </div>
      </form>
    </div>
  );
}
