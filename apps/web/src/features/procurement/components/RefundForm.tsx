import { useState } from 'react';
import { Money, type PurchaseOrder } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import { useSupplierPayables } from '../queries.js';
import { amount } from './shared.js';

const FIELD = 'border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
type Method = 'cash' | 'bank' | 'mobile' | 'cheque';

/**
 * Money the supplier pays back once a return credited beyond what the order
 * owed (#173, decision 4a): the ordering branch's finance staff record it, at
 * most the refund due; a cheque, bank or Telebirr refund names its reference.
 */
export function RefundForm({ po }: { po: PurchaseOrder }) {
  const { showToast } = useToast();
  const { refund } = useSupplierPayables(po.id);
  const [value, setValue] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const { accounts, required: bankAccountRequired } = useBranchBankAccounts(po.branchId, method === 'bank');
  const [problem, setProblem] = useState('');
  const due = Money.of(po.refundDue);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(typed) || !Money.of(typed).greaterThan(0)) return setProblem('Enter an amount more than zero, in whole cents');
    if (Money.of(typed).greaterThan(due)) return setProblem(`At most ${po.currency} ${amount(due)} is due back`);
    if (method !== 'cash' && !reference.trim()) return setProblem('A cheque, bank or Telebirr refund names its reference');
    if (method === 'bank' && bankAccountRequired && !bankAccountId) return setProblem('Select the bank account the refund came into');
    setProblem('');
    refund.mutate(
      { amount: typed, method, ...(reference.trim() && { reference: reference.trim() }), ...(method === 'bank' && bankAccountId ? { bankAccountId } : {}) },
      {
        onSuccess: () => { showToast('Refund recorded', 'success'); setValue(''); setReference(''); },
        onError: (err: Error) => showToast(err.message, 'error'),
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Record Supplier Refund</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">The supplier owes back {po.currency} {amount(due)} after returns.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="refund-amount" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Refund amount ({po.currency})</label>
          <input id="refund-amount" type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={`w-32 ${FIELD}`} />
        </div>
        <div>
          <label htmlFor="refund-method" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Refund method</label>
          <select id="refund-method" value={method} onChange={(e) => setMethod(e.target.value as Method)} className={FIELD}>
            <option value="cash">Cash</option>
            <option value="bank">Bank Transfer</option>
            <option value="mobile">Telebirr</option>
            <option value="cheque">Cheque</option>
          </select>
        </div>
        {method !== 'cash' && (
          <div>
            <label htmlFor="refund-reference" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Refund reference</label>
            <input id="refund-reference" type="text" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} className={`w-40 ${FIELD}`} />
          </div>
        )}
        {method === 'bank' && bankAccountRequired && (
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Bank account</label>
            <BankAccountSelect accounts={accounts} value={bankAccountId} onChange={setBankAccountId} />
          </div>
        )}
        <button type="submit" disabled={refund.isPending}
          className="px-4 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors">Record Refund</button>
      </div>
      {problem && <p role="alert" className="text-xs mt-2 text-red-500">{problem}</p>}
    </form>
  );
}
