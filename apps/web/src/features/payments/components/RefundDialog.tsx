import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money, type Payment } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { paymentMethodPlainLabel } from '../../../lib/paymentMethods.js';
import { usePayment, useRefundPayment } from '../queries.js';
import { amountProblem, refundable } from '../rules.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * Gives back (part of) an order payment, the way it was paid, with a reason
 * (owner decision 3a; was: an inline row that sent "Refund" when no reason was
 * typed and offered the whole payment again after a partial refund).
 */
export function RefundDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const currency = useCurrency();
  const { data } = usePayment(payment.id);
  return data
    ? <RefundForm payment={data} left={refundable(data)} currency={currency} onClose={onClose} />
    : (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-900 rounded-xl p-6 text-sm text-gray-400">Loading...</div>
      </div>
    );
}

function RefundForm({ payment, left, currency, onClose }: { payment: Payment; left: Money; currency: string; onClose: () => void }) {
  const { showToast } = useToast();
  const refund = useRefundPayment();
  const Schema = z.object({
    amount: z.string().superRefine((v, ctx) => {
      const problem = amountProblem(v, left, `At most ${currency} ${left.toFixed(2)} is left to refund`);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
    reason: z.string().trim().min(1, 'A reason is required').max(1000, 'At most 1000 characters'),
  });
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof Schema>>({
    resolver: zodResolver(Schema),
    defaultValues: { amount: left.toFixed(2), reason: '' },
  });

  const onSubmit = handleSubmit((v) => {
    refund.mutate({ id: payment.id, body: { refundAmount: Money.of(v.amount.trim()).toNumber(), reason: v.reason.trim() } }, {
      onSuccess: () => { showToast('Refund processed', 'success'); onClose(); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="refund-dialog-title" onSubmit={onSubmit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="refund-dialog-title" className="text-base font-semibold text-gray-900 dark:text-white">Refund {payment.paymentReference}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Paid {currency} {Money.of(payment.amount).toFixed(2)} by {paymentMethodPlainLabel(payment.paymentMethod)}; {currency} {left.toFixed(2)} is left to refund.
          The money goes back the way it was paid.
        </p>
        <div>
          <label htmlFor="refund-amount" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{`Amount (${currency})`}</label>
          <input id="refund-amount" inputMode="decimal" {...register('amount')} aria-invalid={errors.amount ? true : undefined} className={INPUT} />
          {errors.amount && <p role="alert" className="text-xs mt-1 text-red-500">{errors.amount.message}</p>}
        </div>
        <div>
          <label htmlFor="refund-reason" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Why is this payment being refunded?</label>
          <textarea id="refund-reason" rows={3} autoFocus {...register('reason')} aria-invalid={errors.reason ? true : undefined} className={`${INPUT} resize-none`} />
          {errors.reason && <p role="alert" className="text-xs mt-1 text-red-500">{errors.reason.message}</p>}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={refund.isPending} className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 transition-colors bg-red-600 hover:bg-red-700">Refund</button>
        </div>
      </form>
    </div>
  );
}
