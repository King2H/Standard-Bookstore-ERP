import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 resize-none';

/**
 * Confirms a step on an order, and asks for its reason when it needs one,
 * checked with the API's limits before sending (owner decision 1a, #23; was:
 * the browser's prompt and confirm boxes, unchecked).
 */
export function ActionDialog({ title, message, confirmLabel, reason, busy, tone = 'blue', onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  /** Asks for a reason of at most this many characters. */
  reason?: { label: string; max: number };
  busy: boolean;
  tone?: 'blue' | 'red';
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}) {
  const Schema = z.object({
    reason: reason
      ? z.string().trim().min(1, 'A reason is required').max(reason.max, `At most ${reason.max} characters`)
      : z.string(),
  });
  const { register, handleSubmit, formState: { errors } } = useForm<{ reason: string }>({
    resolver: zodResolver(Schema),
    defaultValues: { reason: '' },
  });
  const confirmCls = tone === 'red' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="po-action-title" onSubmit={handleSubmit((v) => onConfirm(reason ? v.reason.trim() : undefined))} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl">
        <h3 id="po-action-title" className="text-base font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{message}</p>
        {reason && <>
          <label htmlFor="po-action-reason" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{reason.label}</label>
          <textarea id="po-action-reason" rows={3} autoFocus {...register('reason')} aria-invalid={errors.reason ? true : undefined} className={INPUT} />
          {errors.reason && <p role="alert" className="text-xs mt-1 text-red-500">{errors.reason.message}</p>}
        </>}
        <div className="flex gap-2 justify-end mt-4">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={busy} className={`px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 transition-colors ${confirmCls}`}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
