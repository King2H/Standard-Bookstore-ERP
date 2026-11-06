import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useCurrency } from '../../../lib/useCurrency.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

const Schema = z.object({
  actualCost: z.string().trim()
    .min(1, "Enter the binder's cost for the job")
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount, e.g. 85.50'),
});

/**
 * Back and ready asks what the binder charged for the job, from the binder's
 * bill (#249, #225 B1; was: nothing asked). The sale keeps its standard cost;
 * the difference is a cost of the day the job is back.
 */
export function BackAndReadyDialog({ jobNumber, busy, onConfirm, onCancel }: {
  jobNumber: string;
  busy: boolean;
  onConfirm: (actualCost: string) => void;
  onCancel: () => void;
}) {
  const currency = useCurrency();
  const { register, handleSubmit, formState: { errors } } = useForm<{ actualCost: string }>({
    resolver: zodResolver(Schema),
    defaultValues: { actualCost: '' },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="back-ready-title" onSubmit={handleSubmit((v) => onConfirm(v.actualCost.trim()))} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl">
        <h3 id="back-ready-title" className="text-base font-semibold text-gray-900 dark:text-white mb-2">{jobNumber} back and ready</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">What the binder charged for this job, from the binder's bill.</p>
        <label htmlFor="back-ready-cost" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Binder's cost ({currency})</label>
        <input id="back-ready-cost" type="text" inputMode="decimal" autoFocus {...register('actualCost')}
          aria-invalid={errors.actualCost ? true : undefined} className={INPUT} />
        {errors.actualCost && <p role="alert" className="text-xs mt-1 text-red-500">{errors.actualCost.message}</p>}
        <div className="flex gap-2 justify-end mt-4">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={busy} className="px-4 py-2 text-sm rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors">Back and ready</button>
        </div>
      </form>
    </div>
  );
}
