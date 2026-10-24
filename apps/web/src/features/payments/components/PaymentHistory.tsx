import { Fragment, useState } from 'react';
import { Money, type Payment, type PaymentStatus } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { paymentMethodLabel } from '../../../lib/paymentMethods.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { usePaymentHistory } from '../queries.js';
import { canRefundPayment, HISTORY_STATUSES, isRefundable, rowKey } from '../rules.js';
import { RefundDialog } from './RefundDialog.js';

const STATUS_COLORS: Record<string, string> = {
  success: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  partially_refunded: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
};

/**
 * Payments taken in the branch, newest first; an order payment can be
 * refunded. Opened on a period (`tab: 'history'`), it shows the dates as a
 * filter to clear (was: the dates were dropped).
 */
export function PaymentHistory({ initialRange }: { initialRange?: { dateFrom: string; dateTo: string } }) {
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [range, setRange] = useState(initialRange);
  const { data, isLoading } = usePaymentHistory({ page, pageSize, status: status || undefined, ...range });

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value as PaymentStatus | ''); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
          <option value="">All statuses</option>
          {HISTORY_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        {range && (
          <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg">
            {range.dateFrom === range.dateTo ? range.dateFrom : `${range.dateFrom} to ${range.dateTo}`}
            <button onClick={() => { setRange(undefined); setPage(1); }} aria-label="Clear dates" className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-200">✕</button>
          </span>
        )}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Reference', 'Order', 'Amount', 'Method', 'Status', 'Date', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {(data?.items ?? []).map((pay) => {
                const key = rowKey(pay);
                return (
                  <Fragment key={key}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpanded(expanded === key ? null : key)}>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                        {pay.paymentReference}
                        {pay.sourceType === 'pos' && (
                          <span className="ml-1.5 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] rounded-sm font-semibold">POS</span>
                        )}
                        {pay.sourceType === 'exchange' && (
                          <span className="ml-1.5 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 text-[10px] rounded-sm font-semibold">Exchange</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{pay.entityNumber ?? `#${pay.orderId}`}</td>
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {Money.of(pay.amount).toFixed(2)}</td>
                      <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{paymentMethodLabel(pay.paymentMethod)}</td>
                      <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[pay.status] ?? ''}`}>{pay.status}</span></td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(pay.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-3">
                        {canRefundPayment(me) && isRefundable(pay) && (
                          <button onClick={(e) => { e.stopPropagation(); setRefunding(pay); }}
                            className="text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950 px-2 py-0.5 rounded-sm transition-colors">
                            Refund
                          </button>
                        )}
                        {pay.sourceType === 'pos' && pay.status !== 'refunded' && <span className="text-xs text-gray-400 italic">POS Returns only</span>}
                        {pay.sourceType === 'exchange' && <span className="text-xs text-gray-400 italic">Manage via Exchanges</span>}
                      </td>
                    </tr>
                    {expanded === key && (
                      <tr>
                        <td colSpan={7} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400">
                          {pay.payerBank && <p>Customer's bank: {pay.payerBank}</p>}
                          {pay.transactionReference && <p>Tx Ref: {pay.transactionReference}</p>}
                          <p>Processed: {new Date(pay.processedAt).toLocaleString()}</p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {(!data?.items || data.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No payments found</p>}
        {data && (
          <Pagination
            page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="payment"
          />
        )}
      </div>

      {refunding && <RefundDialog payment={refunding} onClose={() => setRefunding(null)} />}
    </div>
  );
}
