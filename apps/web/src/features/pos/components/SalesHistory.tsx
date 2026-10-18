import { useState } from 'react';
import type { PosTransaction } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useSales, useVoidSale } from '../queries.js';
import { canVoid } from '../rules.js';

const DATE_INPUT = 'px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

const money = (n: number) => Number(n).toFixed(2);

/**
 * The branch's counter sales, newest first, by date. A sale of today with
 * nothing returned can be voided; a credit sale's balance is collected in
 * Payments.
 */
export function SalesHistory({ initialDateFrom = '', initialDateTo = '', onNavigate }: {
  initialDateFrom?: string;
  initialDateTo?: string;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [voiding, setVoiding] = useState<PosTransaction | null>(null);

  const { data, isLoading } = useSales({ page, pageSize, dateFrom, dateTo });
  const voidSale = useVoidSale();

  function confirmVoid() {
    if (!voiding) return;
    voidSale.mutate(voiding.id, {
      onSuccess: () => { setVoiding(null); showToast('Transaction voided', 'success'); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const copy = (number: string) => {
    navigator.clipboard.writeText(number)
      .then(() => showToast('Transaction ID copied', 'success'))
      .catch(() => showToast('Could not copy — copy manually', 'error'));
  };

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center gap-2 mb-3">
        <input type="date" aria-label="From date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className={DATE_INPUT} />
        <span className="text-xs text-gray-400">to</span>
        <input type="date" aria-label="To date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className={DATE_INPUT} />
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(''); setDateTo(''); setPage(1); }}
            className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Clear
          </button>
        )}
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-xs overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
            <p className="text-sm text-gray-400">Loading transactions…</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  {['Tx #', 'Total', 'Paid', 'Due', 'Status', 'Payment', 'Date', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {(data?.items ?? []).map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50/80 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
                      <button type="button" title="Copy Transaction ID" onClick={() => copy(tx.transactionNumber)}
                        className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors">
                        {tx.transactionNumber}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">{currency} {money(tx.grandTotal)}</td>
                    <td className="px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400 tabular-nums whitespace-nowrap">{currency} {money(tx.amountPaid)}</td>
                    <td className="px-4 py-3 text-sm text-amber-700 dark:text-amber-400 tabular-nums whitespace-nowrap">
                      {tx.amountDue > 0 ? (
                        <div>
                          <div>{currency} {money(tx.amountDue)}</div>
                          {tx.dueDate && <div className="text-[10px] text-gray-400 font-medium">Due: {tx.dueDate}</div>}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tx.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{tx.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tx.paymentStatus === 'paid' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : tx.paymentStatus === 'partial' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{tx.paymentStatus}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{new Date(tx.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {canVoid(me) && tx.voidable && (
                          <button onClick={() => setVoiding(tx)} className="text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 px-2 py-1 rounded-lg font-medium transition-colors whitespace-nowrap">Void</button>
                        )}
                        {/* Payments is the only place that collects: this opens its Collect tab for the sale. */}
                        {tx.status === 'completed' && (tx.paymentStatus === 'partial' || tx.paymentStatus === 'credit') && (
                          <button onClick={() => onNavigate?.('payments', { orderId: tx.id, sourceType: 'pos' })}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 px-2 py-1 rounded-lg font-semibold transition-colors whitespace-nowrap">
                            View Payments
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(!data?.items || data.items.length === 0) && !isLoading && (
          <div className="p-12 text-center"><div className="text-4xl mb-3">📋</div><p className="text-sm text-gray-400">No transactions found</p></div>
        )}
        {data && (
          <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="transaction" />
        )}
      </div>

      {voiding && (
        <ActionDialog
          title="Void Sale"
          message={`Void ${voiding.transactionNumber}? Its books go back to stock and its payments go back the way they came.`}
          confirmLabel="Void Sale"
          tone="red"
          busy={voidSale.isPending}
          onConfirm={confirmVoid}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  );
}
