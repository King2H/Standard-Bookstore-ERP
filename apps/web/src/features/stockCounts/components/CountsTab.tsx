import { useState } from 'react';
import type { StockCountStatus } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useMyProfile } from '../../account/queries.js';
import { useStockCounts } from '../queries.js';
import { canCount, STATUS_LABELS } from '../rules.js';
import { CountDetail } from './CountDetail.js';
import { CountForm } from './CountForm.js';
import { StatusBadge } from './StatusBadge.js';

const SELECT = 'px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

/** The session branch's stock counts (#172, decision 1a); a count opens on its own, and new ones start here. */
export function CountsTab({ initialCountId = null, onOpenHistory }: { initialCountId?: number | null; onOpenHistory: () => void }) {
  const { data: me } = useMyProfile();
  const [openId, setOpenId] = useState<number | null>(initialCountId);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<StockCountStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, isLoading } = useStockCounts({ status: status || undefined, page, pageSize });

  if (creating) return <CountForm onDone={(id) => { setCreating(false); setOpenId(id); }} onCancel={() => setCreating(false)} />;
  if (openId !== null) return <CountDetail id={openId} onBack={() => setOpenId(null)} onOpenHistory={onOpenHistory} />;

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Stock counts</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Count a location, review the differences, post them to stock.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="count-status" className="sr-only">Status</label>
          <select id="count-status" value={status} className={SELECT}
            onChange={(e) => { setStatus(e.target.value as StockCountStatus | ''); setPage(1); }}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as StockCountStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          {canCount(me) && (
            <button type="button" onClick={() => setCreating(true)}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">New count</button>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Number</th>
              <th className="px-4 py-2 text-left">Location</th>
              <th className="px-4 py-2 text-right">Counted</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Opened</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>}
            {data?.items.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">No counts yet.</td></tr>}
            {data?.items.map((c) => (
              <tr key={c.id} onClick={() => setOpenId(c.id)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-2 font-mono text-blue-600 dark:text-blue-400">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(c.id); }}>{c.countNumber}</button>
                </td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{c.locationName}</td>
                <td className="px-4 py-2 text-right">{c.countedLines} / {c.lineCount}</td>
                <td className="px-4 py-2"><StatusBadge status={c.status} /></td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{new Date(c.createdAt).toLocaleDateString()} · {c.createdByName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="count" />
      )}
    </div>
  );
}
