import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, getAccessToken } from '../lib/api.js';

interface AuditEntry {
  id: number;
  staffUsername: string;
  staffRole: string;
  action: string;
  entityType: string;
  entityId: string;
  branchName: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  CREATE:     'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400',
  UPDATE:     'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-400',
  DEACTIVATE: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-400',
  REACTIVATE: 'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-400',
  DELETE:     'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-400',
  LOGIN:      'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400',
  LOGOUT:     'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400',
  // Prompt 3 — Master Data Lifecycle actions (lib/auditLog.ts's LifecycleAction).
  ACTIVATE:   'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-400',
  INACTIVATE: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-400',
  ARCHIVE:    'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  RESTORE:    'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-400',
};

function MetaCell({ meta }: { meta: Record<string, unknown> | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!meta || Object.keys(meta).length === 0) return <span className="text-gray-400 dark:text-gray-600">—</span>;

  const entries = Object.entries(meta);
  const preview = entries.slice(0, 2).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  const hasMore = entries.length > 2;

  return (
    <div className="text-xs">
      {expanded ? (
        <div className="space-y-0.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1">
              <span className="text-gray-500 dark:text-gray-400 font-medium">{k}:</span>
              <span className="text-gray-700 dark:text-gray-300 break-all">{JSON.stringify(v)}</span>
            </div>
          ))}
          <button onClick={() => setExpanded(false)} className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 mt-1">
            ▲ less
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-400 truncate max-w-[160px]">{preview}</span>
          {hasMore && (
            <button onClick={() => setExpanded(true)} className="text-blue-500 hover:text-blue-700 dark:text-blue-400 whitespace-nowrap">
              +{entries.length - 2} more
            </button>
          )}
          {!hasMore && entries.length > 0 && (
            <button onClick={() => setExpanded(true)} className="text-blue-400 hover:text-blue-600 dark:text-blue-500">
              ▼
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [entityTypeFilter, setEntityTypeFilter] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['audit-logs', page, entityTypeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (entityTypeFilter) params.set('entityType', entityTypeFilter);
      return api.get<{ items: AuditEntry[]; total: number; totalPages: number }>(`/audit-logs?${params}`);
    },
    enabled: !!getAccessToken(),
    retry: false,
    staleTime: 0,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const entityTypes = ['branch', 'staff', 'location', 'book', 'supplier', 'purchase_order', 'customer', 'transaction'];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Audit Log</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Immutable record of all system write actions</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 border border-blue-200 dark:border-blue-800 px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors"
          >
            {isFetching ? 'Refreshing...' : '↻ Refresh'}
          </button>
          <select
            value={entityTypeFilter}
            onChange={e => { setEntityTypeFilter(e.target.value); setPage(1); }}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
          >
            <option value="">All entities</option>
            {entityTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm py-8">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading audit log...
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">When</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Staff</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Action</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Entity</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Branch</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {data?.items.map(entry => (
                  <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{entry.staffUsername ?? '—'}</div>
                      <div className="text-xs text-gray-400 dark:text-gray-500">{entry.staffRole}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[entry.action] ?? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400'}`}>
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-700 dark:text-gray-300">{entry.entityType}</div>
                      <div className="text-xs text-gray-400 dark:text-gray-500">ID: {entry.entityId}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">{entry.branchName ?? '—'}</td>
                    <td className="px-4 py-3 max-w-xs">
                      <MetaCell meta={entry.meta} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!data?.items || data.items.length === 0) && (
              <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No audit log entries found</p>
            )}
          </div>

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Showing {((page - 1) * 25) + 1}–{Math.min(page * 25, data.total)} of {data.total} entries
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                >
                  Previous
                </button>
                <span className="px-3 py-1 text-xs text-gray-600 dark:text-gray-400">
                  Page {page} of {data.totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
