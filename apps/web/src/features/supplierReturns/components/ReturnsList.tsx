import { useState } from 'react';
import type { SupplierReturnStatus } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useSupplierReturns } from '../queries.js';
import { STATUS_LABELS } from '../rules.js';
import { StatusBadge } from './StatusBadge.js';

const SELECT = 'px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

/** The session branch's returns to supplier, sent from it or of its orders (#173, decision 1a). */
export function ReturnsList({ onOpen }: { onOpen: (id: number) => void }) {
  const currency = useCurrency();
  const [status, setStatus] = useState<SupplierReturnStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, isLoading } = useSupplierReturns({ status: status || undefined, page, pageSize });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">Books sent back against purchase orders; start one from the order's page.</p>
        <div className="ml-auto">
          <label htmlFor="return-status" className="sr-only">Status</label>
          <select id="return-status" value={status} className={SELECT} onChange={(e) => { setStatus(e.target.value as SupplierReturnStatus | ''); setPage(1); }}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as SupplierReturnStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </div>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Number</th>
              <th className="px-4 py-2 text-left">Order</th>
              <th className="px-4 py-2 text-left">Supplier</th>
              <th className="px-4 py-2 text-right">Copies</th>
              <th className="px-4 py-2 text-right">Credit</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Drafted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading && <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>}
            {data?.items.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No returns to supplier yet.</td></tr>}
            {data?.items.map((r) => (
              <tr key={r.id} onClick={() => onOpen(r.id)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-2 font-mono text-blue-600 dark:text-blue-400">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>{r.returnNumber}</button>
                </td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.poNumber}</td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.supplierName}</td>
                <td className="px-4 py-2 text-right">{r.totalQuantity}</td>
                <td className="px-4 py-2 text-right">{formatCurrency(r.creditValue, currency)}</td>
                <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{new Date(r.createdAt).toLocaleDateString()} · {r.createdByName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="return" />
      )}
    </div>
  );
}
