import { Fragment, useState } from 'react';
import { Money } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useReturn, useReturns } from '../queries.js';
import { refundLabel } from '../rules.js';

/** The branch's returns, newest first; a row opens to what came back and how its value went back. */
export function ReturnsHistory() {
  const currency = useCurrency();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data: listData, isLoading } = useReturns({ page, pageSize });

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Return #', 'Sale / Order #', 'Value', 'Refunded As', 'Status', 'Date'].map((h) => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {(listData?.items ?? []).map((ret) => (
                <Fragment key={ret.id}>
                  <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === ret.id ? null : ret.id)}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{ret.returnNumber}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{ret.transactionNumber ?? ret.orderNumber}</td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {Money.of(ret.totalRefundAmount).toFixed()}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{refundLabel(ret.refundMethod)}</td>
                    <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ret.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>{ret.status}</span></td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(ret.createdAt).toLocaleString()}</td>
                  </tr>
                  {expandedId === ret.id && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                        {ret.reason && <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Reason: {ret.reason}</p>}
                        <ReturnDetail returnId={ret.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {(!listData?.items || listData.items.length === 0) && !isLoading && (
          <p className="text-center text-gray-400 text-sm py-8">No returns found</p>
        )}
        {listData && (
          <Pagination
            page={page} pageSize={pageSize} total={listData.total} totalPages={listData.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="return"
          />
        )}
      </div>
    </div>
  );
}

function ReturnDetail({ returnId }: { returnId: string }) {
  const currency = useCurrency();
  const { data } = useReturn(returnId);
  if (!data?.lineItems) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <div className="space-y-2">
      <table className="text-xs w-full max-w-lg">
        <thead><tr className="text-gray-500 dark:text-gray-400">{['Book', 'Qty', 'Value'].map((h) => <th key={h} className="text-left pr-4 pb-1">{h}</th>)}</tr></thead>
        <tbody>{data.lineItems.map((li) => <tr key={li.id}><td className="pr-4 text-gray-900 dark:text-white">{li.bookTitle}</td><td className="pr-4 text-gray-600 dark:text-gray-400">{li.quantity}</td><td className="text-gray-900 dark:text-white">{currency} {Money.of(li.lineRefundAmount).toFixed()}</td></tr>)}</tbody>
      </table>
      {data.refunds && data.refunds.length > 0 && (
        <ul className="text-xs text-gray-600 dark:text-gray-400">
          {data.refunds.map((r) => <li key={r.id}>{refundLabel(r.method)}: {currency} {Money.of(r.amount).toFixed()}</li>)}
        </ul>
      )}
    </div>
  );
}
