import { useEffect, useState } from 'react';
import { Money, type Service, type ServiceRequest } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { StatusBadge, StatusFilter, type StatusFilterValue } from '../../../components/StatusFilter.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import type { ServiceAction } from '../api.js';
import { useSaveService, useServiceAction, useServices } from '../queries.js';
import { canManageServices } from '../rules.js';
import { BranchFeeDialog } from './BranchFeeDialog.js';
import { ServiceForm } from './ServiceForm.js';

const TH = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide';
const DONE: Record<ServiceAction, string> = { deactivate: 'Deactivated', activate: 'Activated', archive: 'Archived', restore: 'Restored' };

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/**
 * The services list (#169): binding and, later, other fees a sale carries
 * next to its books. Everyone who opens the catalog reads it; Admin and
 * Manager change it and set their branch's fee (owner decisions 1a, 2a).
 */
export function ServicesTab() {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const canManage = canManageServices(me);
  const [searchRaw, setSearchRaw] = useState('');
  const q = useDebounce(searchRaw.trim(), 300);
  const [status, setStatus] = useState<StatusFilterValue>('active');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [form, setForm] = useState<{ editing: Service | null } | null>(null);
  const [formError, setFormError] = useState('');
  const [feeFor, setFeeFor] = useState<Service | null>(null);
  useEffect(() => setPage(1), [q, status]);

  const { data, isLoading } = useServices({ q: q || undefined, status, page, pageSize });
  const save = useSaveService();
  const action = useServiceAction();

  function onSave(body: ServiceRequest) {
    const editing = form?.editing ?? null;
    setFormError('');
    save.mutate({ id: editing?.id ?? null, body }, {
      onSuccess: () => { showToast(editing ? 'Service updated' : 'Service added', 'success'); setForm(null); },
      onError: (e: Error) => setFormError(e.message),
    });
  }

  function run(s: Service, a: ServiceAction) {
    action.mutate({ id: s.id, action: a }, {
      onSuccess: () => showToast(DONE[a], 'success'),
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const money = (n: number) => `${currency} ${Money.of(n).toFixed(2)}`;
  const columns = ['Code', 'Service', 'Cover', 'Fee', 'Standard cost', 'Discount', 'Turnaround', 'Status', ...(canManage ? [''] : [])];

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center gap-4 shrink-0">
        <span className="text-lg">🧵</span>
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Services</h2>
          {data && <p className="text-xs text-gray-400">{data.total} {data.total === 1 ? 'service' : 'services'}</p>}
        </div>
        <div className="flex-1 max-w-xs">
          <input value={searchRaw} onChange={(e) => setSearchRaw(e.target.value)} placeholder="Search code or name…"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        </div>
        <StatusFilter value={status} onChange={setStatus} />
        <div className="flex-1" />
        {canManage && (
          <button type="button" onClick={() => { setFormError(''); setForm({ editing: null }); }}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">+ Add Service</button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>{columns.map((c, i) => <th key={i} className={`${TH} ${['Fee', 'Standard cost', 'Turnaround', ''].includes(c) ? 'text-right' : 'text-left'}`}>{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">Loading…</td></tr>
            ) : !data?.items.length ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">No services found</td></tr>
            ) : data.items.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{s.code}</td>
                <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{s.name}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{s.formatLabel ?? '—'}</td>
                <td className="px-4 py-3 text-right">
                  <span className="text-gray-900 dark:text-white">{money(s.effectiveFee)}</span>
                  {s.branchFee !== null && <div className="text-xs text-gray-400">{`this branch · shop ${money(s.fee)}`}</div>}
                </td>
                <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400">{money(s.standardCost)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{s.discountable ? 'Allowed' : 'No'}</td>
                <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400">{s.turnaroundDays} {s.turnaroundDays === 1 ? 'day' : 'days'}</td>
                <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                {canManage && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-3 justify-end">
                      <button type="button" onClick={() => { setFormError(''); setForm({ editing: s }); }} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                      <button type="button" onClick={() => setFeeFor(s)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Branch fee</button>
                      {s.status === 'ACTIVE'
                        ? <button type="button" onClick={() => run(s, 'deactivate')} className="text-xs text-yellow-600 dark:text-yellow-400 hover:underline">Deactivate</button>
                        : s.status === 'INACTIVE' && <button type="button" onClick={() => run(s, 'activate')} className="text-xs text-green-600 dark:text-green-400 hover:underline">Activate</button>}
                      {s.status === 'ARCHIVED'
                        ? <button type="button" onClick={() => run(s, 'restore')} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Restore</button>
                        : <button type="button" onClick={() => run(s, 'archive')} className="text-xs text-amber-600 dark:text-amber-400 hover:underline">Archive</button>}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="service" />
      )}
      {form && <ServiceForm editing={form.editing} saving={save.isPending} error={formError} onSave={onSave} onClose={() => setForm(null)} />}
      {feeFor && <BranchFeeDialog service={feeFor} onClose={() => setFeeFor(null)} />}
    </div>
  );
}
