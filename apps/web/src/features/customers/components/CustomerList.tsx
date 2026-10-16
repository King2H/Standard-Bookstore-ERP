import { useEffect, useState } from 'react';
import type { Customer } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { StatusBadge, StatusFilter, type StatusFilterValue } from '../../../components/StatusFilter.js';
import { useMyProfile } from '../../account/queries.js';
import { useCreateCustomer, useCustomers } from '../queries.js';
import { canChangeCustomerStatus, canEditCustomers } from '../rules.js';
import { CustomerForm } from './CustomerForm.js';
import { StatusActions } from './StatusActions.js';

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Every customer, searched and filtered by status, with a drawer to add one. */
export function CustomerList({ onOpen }: { onOpen: (c: Customer) => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const canEdit = canEditCustomers(me);
  const canChangeStatus = canChangeCustomerStatus(me);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [qRaw, setQRaw] = useState('');
  // Asks once typing pauses (was: on every key).
  const q = useDebounce(qRaw.trim(), 300);
  const [status, setStatus] = useState<StatusFilterValue>('active');
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setPage(1), [q, status]);

  const { data, isLoading } = useCustomers({ page, pageSize, q: q || undefined, status });
  const create = useCreateCustomer();
  const customers = data?.items ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="text" placeholder="Search by name, phone, code..." value={qRaw} onChange={e => setQRaw(e.target.value)}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-64 focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        <StatusFilter value={status} onChange={setStatus} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} customers</span>
          {canEdit && (
            <button type="button" onClick={() => setDrawerOpen(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              + New Customer
            </button>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : customers.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No customers found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Code', 'Name', 'Phone', 'Loyalty Pts', 'Store Credit', 'Status', 'Actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {customers.map(c => (
                <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{c.customerCode}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.fullName}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{c.phone ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{c.loyaltyBalance.toFixed(0)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{currency} {c.storeCreditBalance.toFixed(2)}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-xs">
                      <button type="button" onClick={() => onOpen(c)} className="px-2 py-1 rounded-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">View</button>
                      {canChangeStatus && <StatusActions customer={c} compact />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && (
          <Pagination
            page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="customer"
          />
        )}
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="New Customer" className="w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">New Customer</h2>
              <button type="button" aria-label="Close" onClick={() => setDrawerOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
            </div>
            <CustomerForm customer={null} className="flex-1 p-6 space-y-4"
              onSubmit={(body) => create.mutate(body, {
                onSuccess: () => { setDrawerOpen(false); showToast('Customer created', 'success'); },
                onError: (e: Error) => showToast(e.message, 'error'),
              })}>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setDrawerOpen(false)} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
                <button type="submit" disabled={create.isPending} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{create.isPending ? 'Saving...' : 'Create Customer'}</button>
              </div>
            </CustomerForm>
          </div>
        </div>
      )}
    </div>
  );
}
