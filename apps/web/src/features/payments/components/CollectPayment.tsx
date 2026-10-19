import { useState } from 'react';
import { Money, type UnpaidItem } from '@bms/shared';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import PaymentMethodTabs from '../../../components/PaymentMethodTabs.js';
import PaymentProofFields from '../../../components/PaymentProofFields.js';
import { useToast } from '../../../components/Toast.js';
import { getCurrentBranchId } from '../../../lib/api.js';
import { EMPTY_PROOF, needsProof, proofFields } from '../../../lib/paymentProof.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import { useCustomer } from '../../customers/queries.js';
import { isAmount } from '../../pos/sale.js';
import { useCollectPayment, useOrderBalance, type CollectInput } from '../queries.js';
import { COLLECT_METHODS, collectionProblem, outstandingOf } from '../rules.js';

const FIELD = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const money = (n: number | Money) => Money.of(n).toFixed();

const HEADINGS: Record<UnpaidItem['sourceType'], string> = {
  order: 'Collecting Payment For',
  pos: '🏷️ POS Credit Sale — Collecting Payment',
  exchange_difference: '🔁 Exchange Balance — Collecting Payment',
};

/**
 * Takes a payment on what a customer owes, through the endpoint of its source,
 * with the methods that endpoint accepts (owner decision 2a). Store credit and
 * loyalty points are checked against the balances of the customer who owes it
 * (decision 1a; was: looked up as if every row were an order).
 */
export function CollectPayment({ item, onDone, onCancel }: { item: UnpaidItem; onDone: () => void; onCancel: () => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const methods = COLLECT_METHODS[item.sourceType];
  const [method, setMethod] = useState<string>('cash');
  const [amount, setAmount] = useState(Money.of(item.outstanding).toFixed(2));
  const [proof, setProof] = useState(EMPTY_PROOF);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const collect = useCollectPayment();

  const { data: balance, isLoading: loadingBalance } = useOrderBalance(item.sourceType === 'order' ? item.id : null);
  const outstanding = outstandingOf(item, balance);
  const usesAccount = method === 'store_credit' || method === 'loyalty_points';
  const { data: customer } = useCustomer(usesAccount ? item.customerId : null);
  const { accounts, required: bankAccountRequired } = useBranchBankAccounts(getCurrentBranchId(), method === 'bank');

  function submit() {
    const problem = collectionProblem({
      method, amount, outstanding, proof, bankAccountId, bankAccountRequired,
      customer: item.customerId === null ? null : (customer ?? 'loading'),
    });
    if (problem) { showToast(problem, 'error'); return; }
    const value = Money.of(amount.trim()).toNumber();
    const { payerBank, reference } = proofFields(method, proof);
    const account = method === 'bank' && bankAccountId !== null ? { bankAccountId } : {};
    // `method` is one of COLLECT_METHODS[item.sourceType]: that endpoint's own methods.
    const input: CollectInput = item.sourceType === 'pos'
      ? { sourceType: 'pos', id: item.id, body: { payments: [{ method: method as 'cash', amount: value, reference, payerBank, ...account }] } }
      : item.sourceType === 'exchange_difference'
        ? { sourceType: 'exchange_difference', id: item.id, body: { amount: value, paymentMethod: method as 'cash', transactionReference: reference, payerBank, ...account } }
        : { sourceType: 'order', body: { orderId: Number(item.id), amount: value, paymentMethod: method as 'cash', transactionReference: reference, payerBank, ...account } };
    collect.mutate(input, {
      onSuccess: () => { showToast(`Payment of ${currency} ${money(value)} recorded on ${item.orderNumber}`, 'success'); onDone(); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const shown = isAmount(amount) ? Money.of(amount.trim()).toFixed(2) : '0.00';
  const noCustomer = item.customerId === null;

  return (
    <div className="flex-1 overflow-auto p-4 pb-6 max-w-xl mx-auto w-full space-y-4">
      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">{HEADINGS[item.sourceType]}</p>
            <p className="text-base font-bold text-blue-900 dark:text-blue-200 mt-0.5">{item.orderNumber}</p>
            {item.customerName && <p className="text-sm text-blue-700 dark:text-blue-300">{item.customerName} ({item.customerCode})</p>}
          </div>
          <button onClick={onCancel} className="text-blue-400 hover:text-blue-600 text-sm">✕ Cancel</button>
        </div>
        {loadingBalance ? (
          <div className="mt-3 text-xs text-blue-500">Loading balance...</div>
        ) : (
          <div className="mt-3 space-y-1 text-sm border-t border-blue-200 dark:border-blue-800 pt-3">
            <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Order Total</span><span className="font-medium text-blue-900 dark:text-blue-200">{currency} {money(balance?.orderTotal ?? item.total)}</span></div>
            <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Already Paid</span><span className="text-green-600 dark:text-green-400">{currency} {money(balance?.totalPaid ?? item.totalPaid)}</span></div>
            {balance && balance.totalRefunded > 0 && <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Refunded</span><span className="text-amber-600 dark:text-amber-400">{currency} {money(balance.totalRefunded)}</span></div>}
            <div className="flex justify-between font-bold border-t border-blue-200 dark:border-blue-800 pt-1">
              <span className="text-blue-900 dark:text-blue-200">Outstanding</span>
              <span className="text-red-600 dark:text-red-400">{currency} {money(outstanding)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Payment Method</h3>
        <PaymentMethodTabs methods={methods} value={method} onChange={(m) => { setMethod(m); setBankAccountId(null); }} columns={3} />

        {method === 'bank' && bankAccountRequired && (
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Bank Account <span className="text-red-500">*</span></label>
            <BankAccountSelect accounts={accounts} value={bankAccountId} onChange={setBankAccountId} className={FIELD} />
          </div>
        )}

        {usesAccount && (
          <div className={`p-3 rounded-lg text-xs border ${
            noCustomer
              ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
              : customer
                ? method === 'store_credit'
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                  : 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300'
                : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500'
          }`}>
            {noCustomer ? (
              method === 'store_credit'
                ? '⚠️ This sale has no customer. Store credit requires a linked customer.'
                : '⚠️ This sale has no customer. Loyalty points require a linked customer.'
            ) : customer ? (
              <div className="space-y-0.5">
                <p className="font-medium">{customer.fullName}</p>
                {method === 'store_credit'
                  ? <p>Available Store Credit: <strong>{currency} {money(customer.storeCreditBalance)}</strong></p>
                  : <p>Available Points: <strong>{Money.of(customer.loyaltyBalance).toFixed(0)} pts</strong> ({currency} {money(customer.loyaltyBalance)} value)</p>}
                {isAmount(amount) && Money.of(amount.trim()).greaterThan(method === 'store_credit' ? customer.storeCreditBalance : customer.loyaltyBalance) && (
                  <p className="text-red-600 dark:text-red-400 font-medium">
                    {method === 'store_credit' ? '⚠️ Requested amount exceeds available balance' : '⚠️ Requested amount exceeds available points'}
                  </p>
                )}
              </div>
            ) : 'Loading customer balance...'}
          </div>
        )}

        <div>
          <label htmlFor="collect-amount" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{`Amount (${currency})`}</label>
          <div className="flex gap-2">
            <input id="collect-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
            {outstanding.greaterThan(0) && (
              <button onClick={() => setAmount(outstanding.toFixed(2))}
                className="px-3 py-2 text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors whitespace-nowrap">
                Full {currency} {money(outstanding)}
              </button>
            )}
          </div>
        </div>

        {needsProof(method) ? (
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              {method === 'bank' ? "Customer's Bank and Transfer Reference" : 'Telebirr Transaction Number'} <span className="text-red-500">*</span>
            </label>
            <PaymentProofFields method={method} value={proof} onChange={setProof} inputClassName={FIELD} />
          </div>
        ) : (
          <div>
            <label htmlFor="collect-reference" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Transaction Reference (optional)</label>
            <input id="collect-reference" value={proof.reference} onChange={(e) => setProof({ ...proof, reference: e.target.value })} placeholder="Receipt or card slip number..." className={FIELD} />
          </div>
        )}

        <button onClick={submit} disabled={collect.isPending}
          className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
          {collect.isPending ? 'Processing...' : `✓ Record Payment — ${currency} ${shown}`}
        </button>
      </div>
    </div>
  );
}
