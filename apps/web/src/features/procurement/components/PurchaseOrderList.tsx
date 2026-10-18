import { useState } from 'react';
import type { PurchaseOrder, PurchaseOrderStatus } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { SearchPicker, type PickerOption } from '../../../shared/components/SearchPicker.js';
import { useMyProfile } from '../../account/queries.js';
import { searchSuppliers } from '../api.js';
import { usePurchaseOrders } from '../queries.js';
import { canBuy, canReadLedger, stepsFor } from '../rules.js';
import { PURCHASE_ORDER_STATUSES, ProgressBar, StatusBadge, amount, safePct } from './shared.js';

const FIELD = 'border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/** The session branch's purchase orders, with each row's quick actions. */
export function PurchaseOrderList({ initialContext, onOpen, onCreate, onEdit, onReceive, onLedger }: {
  initialContext: Record<string, string>;
  onOpen: (po: PurchaseOrder) => void;
  onCreate: () => void;
  onEdit: (po: PurchaseOrder) => void;
  onReceive: (po: PurchaseOrder) => void;
  onLedger: (supplierId: number, supplierName: string) => void;
}) {
  const { data: me } = useMyProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [status, setStatus] = useState<PurchaseOrderStatus | ''>('');
  // The API filters by supplier, across every page (was: only the rows already on screen).
  const [supplier, setSupplier] = useState<PickerOption | null>(null);
  // The Dashboard's Procurement Expense drill-down passes a date range and branch.
  const [dateFrom, setDateFrom] = useState(initialContext.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(initialContext.dateTo ?? '');
  const branchId = initialContext.branchId || undefined;

  const { data, isLoading } = usePurchaseOrders({
    status: status || undefined, supplierId: supplier?.id, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
    branchId, page, pageSize,
  });
  const orders = data?.items ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchPicker value={supplier} onChange={(s) => { setSupplier(s); setPage(1); }} search={searchSuppliers} queryKey="po-suppliers"
          placeholder="Search by supplier..." aria-label="Supplier" className={`${FIELD} px-3 py-2 w-56`} />
        <select value={status} onChange={e => { setStatus(e.target.value as PurchaseOrderStatus | ''); setPage(1); }} aria-label="Status" className={`${FIELD} px-3 py-2`}>
          <option value="">All Statuses</option>
          {PURCHASE_ORDER_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} aria-label="From" className={`${FIELD} px-2 py-2`} />
        <span className="text-xs text-gray-400">to</span>
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} aria-label="To" className={`${FIELD} px-2 py-2`} />
        {(status || dateFrom || dateTo || supplier) && (
          <button onClick={() => { setStatus(''); setDateFrom(''); setDateTo(''); setSupplier(null); setPage(1); }}
            className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Clear
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} orders</span>
          {canBuy(me) && (
            <button onClick={onCreate} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              + New PO
            </button>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : orders.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No purchase orders found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                {['PO Number', 'Supplier', 'Status', 'Total', 'Received', 'Paid / Outstanding', 'Expected Date', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {orders.map(po => {
                const receivingPct = safePct(po.receivedQuantityTotal, po.orderedQuantityTotal);
                const steps = stepsFor(po, me);
                return (
                  <tr key={po.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">{po.poNumber}</td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{po.supplierName}</td>
                    <td className="px-4 py-3"><StatusBadge status={po.status} /></td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{po.currency} {amount(po.totalAmount)}</td>
                    <td className="px-4 py-3 w-28">
                      <ProgressBar label="" pct={receivingPct} tone="blue" caption={`${Math.round(receivingPct * 100)}%`} />
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      <span className="font-medium text-gray-900 dark:text-white">{po.currency} {amount(po.amountPaid)} paid</span>
                      {po.outstandingAmount > 0 && (
                        <span className="block text-amber-600 dark:text-amber-400">{po.currency} {amount(po.outstandingAmount)} outstanding</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{po.expectedDeliveryDate ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-xs">
                        <button onClick={() => onOpen(po)} className="px-2 py-1 rounded-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">View</button>
                        {steps.edit && (
                          <button onClick={() => onEdit(po)} className="px-2 py-1 rounded-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Edit</button>
                        )}
                        {steps.receive && (
                          <button onClick={() => onReceive(po)} className="px-2 py-1 rounded-sm text-green-600 hover:bg-green-50 dark:hover:bg-green-950 transition-colors">Receive</button>
                        )}
                        {canReadLedger(me) && (
                          <button onClick={() => onLedger(po.supplierId, po.supplierName)} className="px-2 py-1 rounded-sm text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950 transition-colors">Ledger</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && (
          <Pagination
            page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="purchase order"
          />
        )}
      </div>
    </div>
  );
}
