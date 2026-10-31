import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CancelOrderRequestSchema, Money, type CancelOrderRequest, type Order } from '@bms/shared';
import { useOrder } from '../queries.js';
import { shareOf } from '../rules.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 resize-none';

/**
 * Cancels what a part-delivered order will not deliver (#174, decision 4a):
 * the copies and what they are worth, why, and, when the order took money,
 * how it goes back. A credit order's debt takes the value first.
 */
export function CancelRestDialog({ order, currency, busy, onConfirm, onCancel }: {
  order: Pick<Order, 'id' | 'orderNumber' | 'amountPaid' | 'customerId' | 'saleType'>;
  currency: string;
  busy: boolean;
  onConfirm: (body: CancelOrderRequest) => void;
  onCancel: () => void;
}) {
  const { data } = useOrder(order.id);
  const rest = (data?.lineItems ?? []).filter((l) => l.qtyReserved > 0);
  const value = Money.sum(rest.map((l) => shareOf(l, l.qtyReserved)));
  const credit = order.saleType === 'credit_sale';
  const paid = order.amountPaid > 0;
  const Schema = CancelOrderRequestSchema.refine((v) => !paid || v.refundTo !== undefined, {
    message: 'Choose how the money goes back', path: ['refundTo'],
  });
  const { register, handleSubmit, formState: { errors } } = useForm<z.input<typeof Schema>, unknown, CancelOrderRequest>({
    resolver: zodResolver(Schema),
    defaultValues: { reason: '', refundTo: paid ? 'original' : undefined },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="cancel-rest-title" onSubmit={handleSubmit(onConfirm)} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl">
        <h3 id="cancel-rest-title" className="text-base font-semibold text-gray-900 dark:text-white mb-2">Cancel the rest of {order.orderNumber}</h3>
        {!data ? <p className="text-sm text-gray-400">Loading...</p> : (
          <>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">These copies will not be delivered; they go back to stock:</p>
            <ul className="text-sm text-gray-900 dark:text-white mb-2 list-disc pl-5">
              {rest.map((l) => <li key={l.id}>{l.bookTitle} × {l.qtyReserved}</li>)}
            </ul>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Worth <strong className="text-gray-900 dark:text-white">{currency} {value.toFixed(2)}</strong>.{' '}
              {credit
                ? 'It comes off what the customer owes first; anything paid beyond that goes back.'
                : 'It goes back now.'}
              {' '}The order is then completed.
            </p>
          </>
        )}
        {paid && (
          <fieldset className="mb-4">
            <legend className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">How does the money go back?</legend>
            <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
              <input type="radio" value="original" {...register('refundTo')} /> Refund the way it was paid
            </label>
            {order.customerId !== null && (
              <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
                <input type="radio" value="store_credit" {...register('refundTo')} /> Store credit for the customer
              </label>
            )}
            {errors.refundTo && <p role="alert" className="text-xs text-red-500 mt-1">{errors.refundTo.message}</p>}
          </fieldset>
        )}
        <label htmlFor="cancel-rest-reason" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Why will the rest not be delivered?</label>
        <textarea id="cancel-rest-reason" rows={3} autoFocus {...register('reason')} aria-invalid={errors.reason ? true : undefined} className={INPUT} />
        {errors.reason && <p role="alert" className="text-xs text-red-500 mt-1">{errors.reason.message}</p>}
        <div className="flex gap-3 mt-5">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">Back</button>
          <button type="submit" disabled={busy || !data}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">
            {busy ? 'Cancelling…' : 'Cancel the rest'}
          </button>
        </div>
      </form>
    </div>
  );
}
