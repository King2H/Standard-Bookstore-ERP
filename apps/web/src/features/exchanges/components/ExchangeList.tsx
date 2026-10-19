import { Fragment, useState } from 'react';
import { Money, type Exchange } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useExchange, useExchanges, useVoidExchange } from '../queries.js';
import { canVoidExchange } from '../rules.js';
import { ExchangeSlip } from './ExchangeSlip.js';

const money = (n: number) => Money.of(n).toFixed();

/** The branch's exchanges, newest first; one made today can be voided, with a reason. */
export function ExchangeList() {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Exchange | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const { data: listData, isLoading } = useExchanges({ page, pageSize });
  const voidMut = useVoidExchange();

  function confirmVoid(reason?: string) {
    if (!voiding || !reason) return;
    voidMut.mutate({ id: voiding.id, reason }, {
      onSuccess: () => { setVoiding(null); showToast('Exchange voided', 'success'); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Reference', 'Incoming', 'Outgoing', 'Difference', 'Outstanding', 'Settlement Status', 'Date', 'Actions'].map((h) => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {(listData?.items ?? []).map((exc) => (
                <Fragment key={exc.id}>
                  <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === exc.id ? null : exc.id)}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{exc.exchangeReference}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">{currency} {money(exc.totalIncomingValue)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">{currency} {money(exc.totalOutgoingValue)}</td>
                    <td className="px-4 py-3 text-sm font-medium whitespace-nowrap">
                      <div style={{ color: exc.netBalance > 0 ? '#d97706' : exc.netBalance < 0 ? '#2563eb' : '#6b7280' }}>
                        {exc.netBalance > 0 ? '+' : ''}{money(exc.netBalance)}
                      </div>
                      <div className="text-[10px] text-gray-400 font-medium">
                        {exc.settlementType === 'Even' ? 'Even Exchange' : exc.settlementType === 'Customer_Pays' ? 'Customer Pays' : 'Store Refunds'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">
                      {exc.outstandingAmount > 0 ? `${currency} ${money(exc.outstandingAmount)}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        exc.settlementStatus === 'Settled'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : exc.settlementStatus === 'PartiallyPaid'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                            : exc.settlementStatus === 'Overdue'
                              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {exc.settlementStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(exc.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {exc.voidable && canVoidExchange(me) && (
                          <button onClick={(e) => { e.stopPropagation(); setVoiding(exc); }} disabled={voidMut.isPending}
                            className="text-xs px-2 py-0.5 rounded-sm transition-colors text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
                            Void
                          </button>
                        )}
                        {exc.status === 'Cancelled' && <span className="text-xs text-gray-400">{exc.voidReason ? `Voided: ${exc.voidReason}` : 'Cancelled'}</span>}
                        {exc.status === 'Completed' && (
                          <button onClick={(e) => { e.stopPropagation(); setPrinting(exc.id); }}
                            className="text-xs px-2 py-0.5 rounded-sm transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                            🖨 Print
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === exc.id && (
                    <tr>
                      <td colSpan={8} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                        <ExchangeDetail exchangeId={exc.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {(!listData?.items || listData.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No exchanges found</p>}
        {listData && (
          <Pagination
            page={page} pageSize={pageSize} total={listData.total} totalPages={listData.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="exchange"
          />
        )}
      </div>

      {printing && <ExchangeSlip exchangeId={printing} onClose={() => setPrinting(null)} />}

      {voiding && (
        <ActionDialog
          title="Void Exchange"
          message={`Void ${voiding.exchangeReference}? The books go back both ways and the money goes back the way it came.`}
          confirmLabel="Void Exchange"
          reason={{ label: 'Why is this exchange being voided?', max: 1000 }}
          tone="red"
          busy={voidMut.isPending}
          onConfirm={confirmVoid}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  );
}

function ExchangeDetail({ exchangeId }: { exchangeId: string }) {
  const currency = useCurrency();
  const { data } = useExchange(exchangeId);
  if (!data) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <div className="grid grid-cols-3 gap-4 text-xs">
      <div>
        <p className="font-semibold text-green-700 dark:text-green-400 mb-1">Incoming Items</p>
        {(data.incomingItems ?? []).map((i) => <p key={i.id} className="text-gray-700 dark:text-gray-300">{i.bookTitle} × {i.quantity} @ {currency} {money(i.unitPrice)}</p>)}
        {(data.incomingItems ?? []).length === 0 && <p className="text-gray-400 italic">No incoming items</p>}
      </div>
      <div>
        <p className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Outgoing Items</p>
        {(data.outgoingItems ?? []).map((i) => <p key={i.id} className="text-gray-700 dark:text-gray-300">{i.bookTitle} × {i.quantity} @ {currency} {money(i.unitPrice)}</p>)}
        {(data.outgoingItems ?? []).length === 0 && <p className="text-gray-400 italic">No outgoing items</p>}
      </div>
      <div className="border-l border-gray-200 dark:border-gray-700 pl-4 space-y-1.5">
        <p className="font-semibold text-purple-700 dark:text-purple-400 mb-1">Settlement Details</p>
        <p className="text-gray-600 dark:text-gray-400">Difference: <span className="font-medium text-gray-900 dark:text-white">{currency} {money(data.netBalance)} ({data.settlementType.replace('_', ' ')})</span></p>
        <p className="text-gray-600 dark:text-gray-400">Status: <span className="font-medium text-gray-900 dark:text-white">{data.settlementStatus}</span></p>
        {data.outstandingAmount > 0 && (
          <p className="text-gray-600 dark:text-gray-400">Outstanding: <span className="font-semibold text-amber-600 dark:text-amber-400">{currency} {money(data.outstandingAmount)}</span></p>
        )}
        {data.dueDate && (
          <p className="text-gray-600 dark:text-gray-400">Due Date: <span className="font-medium text-gray-900 dark:text-white">{data.dueDate}</span></p>
        )}
      </div>
    </div>
  );
}
