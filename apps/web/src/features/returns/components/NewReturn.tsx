import { useState } from 'react';
import { Money } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import type { ReturnableLine, ReturnableSale } from '../api.js';
import { useCreateReturn, useSaleByNumber } from '../queries.js';
import { JOB_STATUS_LABEL } from '../../services/binding.js';
import { approverRole, canProcessReturn, defectiveReturnable, feeValue, lineValue, returnableCopies } from '../rules.js';

type Disposition = 'SELLABLE' | 'DAMAGED';

/**
 * A return at the counter: find the sale or the delivered customer order by
 * its number (#166), pick what comes back and in what state, and process it.
 * The refund goes back the way it was paid, so nothing here chooses a method.
 * A bound copy comes back only defective, taken by a Manager or Admin with a
 * reason, with its share of the fee, and is kept apart (#169 PR 3, 4a).
 * `initialNumber` comes from an order's Return action.
 */
export function NewReturn({ initialNumber = '' }: { initialNumber?: string }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const [txSearch, setTxSearch] = useState(initialNumber.toUpperCase());
  const [txSearchInput, setTxSearchInput] = useState(initialNumber.toUpperCase());
  const [selectedTx, setSelectedTx] = useState<ReturnableSale | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const [defective, setDefective] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');

  const { data: txData, isLoading: txLoading, error: txError } = useSaleByNumber(txSearch);
  const createReturn = useCreateReturn();
  const approver = approverRole(me);

  const tx = selectedTx ?? txData ?? null;
  const lines = tx?.lines ?? [];
  const isOrder = tx?.kind === 'order';
  const isExchange = tx?.kind === 'exchange';
  const value = (li: ReturnableLine) => {
    const qty = quantities[li.id] ?? 0;
    return defective[li.id] ? lineValue(li, qty).plus(feeValue(li, qty)) : lineValue(li, qty);
  };
  const totalRefund = Money.sum(lines.map(value));
  const anyDefective = lines.some((li) => defective[li.id] && (quantities[li.id] ?? 0) > 0);

  function setQty(lineId: string, val: number, max: number) {
    setQuantities((q) => ({ ...q, [lineId]: Math.max(0, Math.min(max, val)) }));
  }

  function markDefective(li: ReturnableLine, on: boolean) {
    setDefective((d) => ({ ...d, [li.id]: on }));
    setQty(li.id, quantities[li.id] ?? 0, returnableCopies(li, on));
  }

  function clear() {
    setSelectedTx(null); setTxSearch(''); setTxSearchInput('');
    setQuantities({}); setDamaged({}); setDefective({});
  }

  function handleSearch() {
    const val = txSearchInput.trim().toUpperCase();
    if (val.length < 6) { showToast('Enter a valid transaction or order number', 'error'); return; }
    setSelectedTx(null);
    setTxSearch(val);
  }

  function submitReturn() {
    if (!tx) return;
    const selectedLines = lines
      .filter((li) => (quantities[li.id] ?? 0) > 0)
      .map((li) => ({
        ...(isOrder ? { orderLineItemId: Number(li.id) } : isExchange ? { exchangeLineItemId: Number(li.id) } : { transactionLineItemId: Number(li.id) }),
        quantity: quantities[li.id],
        ...(defective[li.id]
          ? { disposition: 'DAMAGED' as Disposition, defective: true }
          : { disposition: (damaged[li.id] ? 'DAMAGED' : 'SELLABLE') as Disposition }),
      }));
    if (selectedLines.length === 0) { showToast('Select at least one item to return', 'error'); return; }
    if (anyDefective && !reason.trim()) { showToast('Say what is wrong with the bound copy', 'error'); return; }
    createReturn.mutate(
      {
        ...(isOrder ? { orderId: Number(tx.id) } : isExchange ? { exchangeId: Number(tx.id) } : { transactionId: Number(tx.id) }),
        reason: reason.trim() || undefined, lines: selectedLines,
      },
      {
        onSuccess: (ret) => {
          showToast(`Return ${ret.returnNumber} processed`, 'success');
          clear(); setReason('');
        },
        onError: (e: Error & { code?: string }) => {
          showToast(e.code === 'APPROVAL_REQUIRED' ? 'This refund requires a Manager or Admin to process it directly.' : e.message, 'error');
        },
      },
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 pb-6 max-w-3xl mx-auto w-full space-y-4">

      {/* Step 1: Find transaction */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Step 1 — Find the Sale, Order or Exchange</h3>
        <div className="flex gap-2">
          <input
            aria-label="Transaction or order number"
            value={txSearchInput}
            onChange={(e) => setTxSearchInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Sale, order or exchange number (e.g. POS-20250101-0001, ORD-20250101-0001, EXC-20250101-0001)"
            className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          />
          <button onClick={handleSearch} disabled={txLoading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
            {txLoading ? 'Searching...' : 'Search'}
          </button>
        </div>
        {txError && <p className="text-xs text-red-500">No sale or order with this number in this branch. Check the number and try again.</p>}
        {txData && !selectedTx && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">{txData.kind === 'order' ? 'Order #' : txData.kind === 'exchange' ? 'Exchange #' : 'Tx #'}</span><span className="font-mono text-gray-900 dark:text-white">{txData.number}</span></div>
            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Total</span><span className="text-gray-900 dark:text-white">{currency} {Money.of(txData.total).toFixed()}</span></div>
            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Paid</span><span className="text-gray-900 dark:text-white">{currency} {Money.of(txData.paid).toFixed()}</span></div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500 dark:text-gray-400">Status</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${!txData.returnable ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'}`}>{txData.status}</span>
            </div>
            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">{txData.kind === 'order' && txData.returnable ? 'Delivered' : 'Date'}</span><span className="text-gray-900 dark:text-white">{new Date(txData.date).toLocaleString()}</span></div>
            {txData.returnable ? (
              <button onClick={() => setSelectedTx(txData)} className="w-full mt-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors">
                {txData.kind === 'order' ? 'Use this order →' : txData.kind === 'exchange' ? 'Use this exchange →' : 'Use this transaction →'}
              </button>
            ) : txData.kind === 'order' && (
              <p className="text-xs text-amber-700 dark:text-amber-400 pt-1">This order was not delivered: cancel it in Orders instead of returning it.</p>
            )}
          </div>
        )}
        {selectedTx && (
          <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">✓ {selectedTx.number}</span>
            <button onClick={clear} className="text-xs text-gray-500 hover:text-red-500 transition-colors">Change</button>
          </div>
        )}
      </div>

      {/* Step 2: Select items */}
      {tx && tx.returnable && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Step 2 — Select Items to Return</h3>
          {isExchange && lines.length === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">This exchange has no bound copy to take back; books from an exchange are swapped in a new exchange.</p>
          )}
          <div className="space-y-2">
            {lines.map((li) => (
              <div key={li.id} className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{li.bookTitle}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {currency} {Money.of(li.unitPrice).toFixed()} × {li.quantity} {isOrder ? 'delivered' : isExchange ? 'given out' : 'sold'}
                    {li.returned ? ` · ${li.returned} returned` : ''}
                  </p>
                  {li.binding && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      🧵 {li.binding.quantity} bound ({li.binding.status ? JOB_STATUS_LABEL[li.binding.status] : 'not started'}): they come back only defective
                      {li.binding.status === 'COLLECTED' && !approver && '. A Manager or Admin takes back a defective bound copy.'}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">Return:</span>
                  <input type="number" min="0" max={returnableCopies(li, !!defective[li.id])} value={quantities[li.id] ?? 0}
                    aria-label={`Quantity of ${li.bookTitle} to return`}
                    onChange={(e) => setQty(li.id, parseInt(e.target.value) || 0, returnableCopies(li, !!defective[li.id]))}
                    className="w-16 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center focus:outline-hidden focus:ring-1 focus:ring-blue-500" />
                  <span className="text-xs text-gray-400">/ {returnableCopies(li, !!defective[li.id])}</span>
                </div>
                {defectiveReturnable(li, me) && (
                  <label className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400" title="Bound copies, with their share of the fee">
                    <input type="checkbox" checked={!!defective[li.id]} onChange={(e) => markDefective(li, e.target.checked)}
                      className="rounded-sm border-gray-300 dark:border-gray-600" />
                    Defective binding
                  </label>
                )}
                {/* Damaged books are kept apart from the stock for sale. */}
                <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" title="Kept apart, not for sale">
                  <input type="checkbox" checked={!!damaged[li.id] || !!defective[li.id]} disabled={!!defective[li.id]}
                    onChange={(e) => setDamaged((d) => ({ ...d, [li.id]: e.target.checked }))}
                    className="rounded-sm border-gray-300 dark:border-gray-600" />
                  Damaged
                </label>
                <div className="text-sm font-medium text-gray-900 dark:text-white w-24 text-right">
                  {currency} {value(li).toFixed()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Refund details + approval + submit */}
      {tx && tx.returnable && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Step 3 — Refund Details</h3>

          {isExchange ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              The value goes first against what the exchange left on credit, as a credit note; the rest to the customer's store credit.
            </p>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              The refund goes back the way the {isOrder ? 'order' : 'sale'} was paid. On a credit {isOrder ? 'order' : 'sale'} it is first set against what the customer still owes, as a credit note.
              After the return window{isOrder ? ', counted from delivery,' : ''} store policy may allow store credit only.
            </p>
          )}

          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={anyDefective ? 'What is wrong with the bound copy (required)' : 'Reason for return (optional)'}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />

          {approver ? (
            <div className="rounded-lg p-3 border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30">
              <p className="text-sm font-medium text-green-800 dark:text-green-300">✓ Manager/Admin Approval</p>
              <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                As {approver}, you can process returns above the approval limit; you are recorded as approving them.
              </p>
            </div>
          ) : (
            <div className="rounded-lg p-3 border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">⚠ Approval Policy</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                Returns above the approval limit must be processed by a Manager or Admin. Ask them to log in and process this return directly.
              </p>
            </div>
          )}

          <div className="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-700">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Value</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{currency} {totalRefund.toFixed()}</p>
            </div>
            {canProcessReturn(me) && (
              <button onClick={submitReturn}
                disabled={createReturn.isPending || !totalRefund.greaterThan(0)}
                className="px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors text-sm">
                {createReturn.isPending ? 'Processing...' : 'Process Return'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
