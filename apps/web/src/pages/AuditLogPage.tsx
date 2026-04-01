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
  CREATE: 'bg-green-100 text-green-800',
  UPDATE: 'bg-blue-100 text-blue-800',
  DEACTIVATE: 'bg-orange-100 text-orange-800',
  REACTIVATE: 'bg-teal-100 text-teal-800',
  DELETE: 'bg-red-100 text-red-800',
  LOGIN: 'bg-gray-100 text-gray-700',
  LOGOUT: 'bg-gray-100 text-gray-700',
};

function MetaCell({ meta }: { meta: Record<string, unknown> | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!meta || Object.keys(meta).length === 0) return <span className="text-gray-400">—</span>;

  const entries = Object.entries(meta);
  const preview = entries.slice(0, 2).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  const hasMore = entries.length > 2;

  return (
    <div className="text-xs">
      {expanded ? (
        <div className="space-y-0.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1">
              <span className="text-gray-500 font-medium">{k}:</span>
              <span className="text-gray-700 break-all">{JSON.stringify(v)}</span>
            </div>
          ))}
          <button onClick={() => setExpanded(false)} className="text-blue-500 hover:text-blue-700 mt-1">
            ▲ less
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <span className="text-gray-600 truncate max-w-[160px]">{preview}</span>
          {hasMore && (
            <button onClick={() => setExpanded(true)} className="text-blue-500 hover:text-blue-700 whitespace-nowrap">
              +{entries.length - 2} more
            </button>
          )}
          {!hasMore && entries.length > 0 && (
            <button onClick={() => setExpanded(true)} className="text-blue-400 hover:text-blue-600">
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
    refetchInterval: 3_000,        // poll every 3 seconds
    refetchIntervalInBackground: true, // keep polling even when tab is not focused
    refetchOnWindowFocus: true,
  });

  const entityTypes = ['branch', 'staff', 'location', 'book', 'supplier', 'customer'];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Audit Log</h1>
          <p className="text-xs text-gray-500 mt-0.5">Immutable record of all system write actions</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 px-3 py-1.5 rounded disabled:opacity-40"
          >
            {isFetching ? 'Refreshing...' : '↻ Refresh'}
          </button>
          <select
            value={entityTypeFilter}
            onChange={e => { setEntityTypeFilter(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All entities</option>
            {entityTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading audit log...</p>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">When</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Staff</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Action</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Entity</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Branch</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data?.items.map(entry => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{entry.staffUsername ?? '—'}</div>
                      <div className="text-xs text-gray-400">{entry.staffRole}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[entry.action] ?? 'bg-gray-100 text-gray-700'}`}>
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-700">{entry.entityType}</div>
                      <div className="text-xs text-gray-400">ID: {entry.entityId}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{entry.branchName ?? '—'}</td>
                    <td className="px-4 py-3 max-w-xs">
                      <MetaCell meta={entry.meta} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!data?.items || data.items.length === 0) && (
              <p className="text-center text-gray-500 text-sm py-8">No audit log entries found</p>
            )}
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-gray-500">
                Showing {((page - 1) * 25) + 1}–{Math.min(page * 25, data.total)} of {data.total} entries
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="px-3 py-1 text-xs text-gray-600">
                  Page {page} of {data.totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="px-3 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40"
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
