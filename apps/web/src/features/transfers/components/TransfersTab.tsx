import { useState } from 'react';
import type { Transfer, TransferStatus } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useTransfers } from '../queries.js';
import { canTransfer, STATUS_LABELS } from '../rules.js';
import { StatusBadge } from './StatusBadge.js';
import { TransferDetail } from './TransferDetail.js';
import { TransferForm } from './TransferForm.js';

const SELECT = 'px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

/**
 * The transfer notes the session's branch sends (Outgoing) or receives
 * (Incoming), #170 decision 1a; a note opens on its own, and Outgoing starts
 * new ones.
 */
export function TransfersTab({ direction, initialTransferId = null }: { direction: 'outgoing' | 'incoming'; initialTransferId?: number | null }) {
  const { data: me } = useMyProfile();
  const currency = useCurrency();
  const [openId, setOpenId] = useState<number | null>(initialTransferId);
  // null: the list; 'new' or a draft: the form.
  const [editing, setEditing] = useState<'new' | Transfer | null>(null);
  const [status, setStatus] = useState<TransferStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, isLoading } = useTransfers({ direction, status: status || undefined, page, pageSize });

  if (editing) {
    return (
      <TransferForm draft={editing === 'new' ? null : editing}
        onDone={(id) => { setEditing(null); setOpenId(id); }}
        onCancel={() => setEditing(null)} />
    );
  }
  if (openId !== null) {
    return <TransferDetail id={openId} onBack={() => setOpenId(null)} onEdit={setEditing} />;
  }

  const outgoing = direction === 'outgoing';
  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{outgoing ? 'Outgoing transfers' : 'Incoming transfers'}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {outgoing ? 'Books this branch sends to other branches.' : 'Books other branches send to this branch.'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor={`transfer-status-${direction}`} className="sr-only">Status</label>
          <select id={`transfer-status-${direction}`} value={status} className={SELECT}
            onChange={(e) => { setStatus(e.target.value as TransferStatus | ''); setPage(1); }}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as TransferStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          {outgoing && canTransfer(me) && (
            <button type="button" onClick={() => setEditing('new')}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">New transfer</button>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Number</th>
              <th className="px-4 py-2 text-left">{outgoing ? 'To' : 'From'}</th>
              <th className="px-4 py-2 text-right">Copies</th>
              <th className="px-4 py-2 text-right">In transit</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>}
            {data?.items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">{outgoing ? 'No transfers sent yet.' : 'No transfers to receive.'}</td></tr>
            )}
            {data?.items.map((t) => (
              <tr key={t.id} onClick={() => setOpenId(t.id)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-2 font-mono text-blue-600 dark:text-blue-400">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(t.id); }}>{t.transferNumber}</button>
                </td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-300">
                  {outgoing ? t.toBranchName : `${t.fromBranchName} (${t.fromLocationName})`}
                </td>
                <td className="px-4 py-2 text-right">{t.totalQuantity}</td>
                <td className="px-4 py-2 text-right">{t.inTransitValue > 0 ? formatCurrency(t.inTransitValue, currency) : '—'}</td>
                <td className="px-4 py-2"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{new Date(t.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="transfer" />
      )}
    </div>
  );
}
