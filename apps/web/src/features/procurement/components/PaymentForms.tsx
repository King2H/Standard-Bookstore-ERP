import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money, type PurchaseOrder } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import { useSupplierPayables } from '../queries.js';
import { amount } from './shared.js';

const FIELD = 'border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * An amount the API takes for a payable: more than zero, whole cents, and with
 * what was paid and credited before, at most what was ordered (owner decision
 * 4a, #21; was: sent as a float and refused).
 */
function amountSchema(room: Money) {
  return z.string().trim()
    .refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && Money.of(v).greaterThan(0), 'Enter an amount more than zero, in whole cents')
    .refine((v) => !/^\d+(\.\d{1,2})?$/.test(v) || !Money.of(v).greaterThan(room), `At most ETB ${amount(room)} more can be paid or credited on this order`);
}

/** The payment and credit-note forms of an order: the ordering branch's finance staff, once the order is a commitment. */
export function PaymentForms({ po }: { po: PurchaseOrder }) {
  const { showToast } = useToast();
  const { pay, credit } = useSupplierPayables(po.id);
  // Payments and credit notes together stay within what was ordered; what the supplier paid back counts no more (#173).
  const room = Money.max(0, Money.of(po.totalAmount).minus(po.amountPaid).minus(po.creditNotesTotal).plus(po.refundsTotal));
  const [method, setMethod] = useState<'cash' | 'bank' | 'mobile' | 'cheque'>('cash');
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  // The ordering branch pays; with Bank Accounts on, a bank payment names its account (#21).
  const { accounts, required: bankAccountRequired } = useBranchBankAccounts(po.branchId, method === 'bank');
  const [bankProblem, setBankProblem] = useState('');

  const payment = useForm<{ amount: string }>({ resolver: zodResolver(z.object({ amount: amountSchema(room) })), defaultValues: { amount: '' } });
  const creditNote = useForm<{ amount: string; reason: string }>({
    resolver: zodResolver(z.object({
      amount: amountSchema(room),
      reason: z.string().trim().min(1, 'A reason is required').max(1000, 'At most 1000 characters'),
    })),
    defaultValues: { amount: '', reason: '' },
  });

  function recordPayment(v: { amount: string }) {
    if (method === 'bank' && bankAccountRequired && !bankAccountId) { setBankProblem('Select the bank account the payment went out of'); return; }
    setBankProblem('');
    pay.mutate({ amount: v.amount.trim(), paymentMethod: method, ...(method === 'bank' && bankAccountId ? { bankAccountId } : {}) }, {
      onSuccess: () => { showToast('Payment recorded', 'success'); payment.reset({ amount: '' }); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  function recordCredit(v: { amount: string; reason: string }) {
    credit.mutate({ amount: v.amount.trim(), reason: v.reason.trim() }, {
      onSuccess: () => { showToast('Credit note recorded', 'success'); creditNote.reset({ amount: '', reason: '' }); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const paymentProblem = payment.formState.errors.amount?.message ?? bankProblem;
  const creditProblem = creditNote.formState.errors.amount?.message ?? creditNote.formState.errors.reason?.message;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-5">
      <form onSubmit={payment.handleSubmit(recordPayment)} noValidate>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Record Supplier Payment</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="payment-amount" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Amount ({po.currency})</label>
            <input id="payment-amount" type="number" min={0.01} step="0.01" placeholder="0.00" {...payment.register('amount')}
              aria-invalid={payment.formState.errors.amount ? true : undefined} className={`w-32 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="payment-method" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Method</label>
            <select id="payment-method" value={method} onChange={e => setMethod(e.target.value as typeof method)} className={FIELD}>
              <option value="cash">Cash</option>
              <option value="bank">Bank Transfer</option>
              <option value="mobile">Telebirr</option>
              <option value="cheque">Cheque</option>
            </select>
          </div>
          {method === 'bank' && bankAccountRequired && (
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Bank account</label>
              <BankAccountSelect accounts={accounts} value={bankAccountId} onChange={setBankAccountId} />
            </div>
          )}
          <button type="submit" disabled={pay.isPending}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
            Record Payment
          </button>
        </div>
        {paymentProblem && <p role="alert" className="text-xs mt-2 text-red-500">{paymentProblem}</p>}
      </form>

      {/* The way to correct an order's economics after receipt (damaged goods, an overcharge, a negotiated price): lines change only in a draft. */}
      <form onSubmit={creditNote.handleSubmit(recordCredit)} className="pt-4 border-t border-gray-100 dark:border-gray-800" noValidate>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Issue Credit Note</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="credit-amount" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Amount ({po.currency})</label>
            <input id="credit-amount" type="number" min={0.01} step="0.01" placeholder="0.00" {...creditNote.register('amount')}
              aria-invalid={creditNote.formState.errors.amount ? true : undefined} className={`w-32 ${FIELD}`} />
          </div>
          <div className="flex-1 min-w-48">
            <label htmlFor="credit-reason" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Reason</label>
            <input id="credit-reason" type="text" placeholder="e.g. damaged goods, price adjustment" {...creditNote.register('reason')}
              aria-invalid={creditNote.formState.errors.reason ? true : undefined} className={`w-full ${FIELD}`} />
          </div>
          <button type="submit" disabled={credit.isPending}
            className="px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors">
            Issue Credit Note
          </button>
        </div>
        {creditProblem && <p role="alert" className="text-xs mt-2 text-red-500">{creditProblem}</p>}
      </form>
    </div>
  );
}
