import { useState } from 'react';
import type { CreateSupplierRequest, Supplier } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { StatusFilter, type StatusFilterValue } from '../../../components/StatusFilter.js';
import { DependencyDialog } from '../../../components/DependencyDialog.js';
import type { SupplierAction, SupplierListParams } from '../api.js';
import { useCreateSupplier, useDeleteSupplier, useSupplierAction, useSuppliers, useUpdateSupplier } from '../queries.js';
import { SupplierForm } from '../components/SupplierForm.js';
import { SupplierTable } from '../components/SupplierTable.js';

type Role = string;
interface SuppliersPageProps { userRole?: Role; userPermissions?: string[]; }

const canWrite = (r?: Role, perms?: string[]) => (perms?.includes('MANAGE_INVENTORY')) || ['Admin', 'Manager', 'Purchasor', 'Stock_Clerk'].includes(r ?? '');
const canBlacklist = (r?: Role, perms?: string[]) => (perms?.includes('MANAGE_BRANCH') || perms?.includes('MANAGE_STAFF')) || ['Super_Admin', 'Admin', 'Manager'].includes(r ?? '');

/** Asked before an action runs; actions not listed run straight away. */
const CONFIRM: Partial<Record<SupplierAction, (name: string) => string>> = {
  deactivate: (name) => `Deactivate "${name}"?`,
  archive: (name) => `Archive "${name}"?`,
  blacklist: (name) => `Blacklist "${name}"?`,
};
const DONE: Record<SupplierAction, string> = {
  deactivate: 'Deactivated', activate: 'Activated', archive: 'Archived', restore: 'Restored', blacklist: 'Blacklisted',
};

const FILTER = 'border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

export default function SuppliersPage({ userRole, userPermissions }: SuppliersPageProps) {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [q, setQ] = useState('');
  const [filterType, setFilterType] = useState<'' | 'external' | 'publisher'>('');
  // Prompt 3 — Master Data Lifecycle: Active/Inactive/Archived/All, default Active.
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('active');
  const [filterBlacklisted, setFilterBlacklisted] = useState<'' | 'true' | 'false'>('');
  const [drawer, setDrawer] = useState<{ editing: Supplier | null } | null>(null);
  const [depDialog, setDepDialog] = useState<{ supplier: Supplier; usage: Record<string, number> } | null>(null);

  const params: SupplierListParams = {
    page, pageSize, q: q || undefined, supplierType: filterType || undefined, status: statusFilter,
    isBlacklisted: filterBlacklisted || undefined,
  };
  const { data, isLoading } = useSuppliers(params);

  const createMut = useCreateSupplier();
  const updateMut = useUpdateSupplier();
  const deleteMut = useDeleteSupplier();
  const actions: Record<SupplierAction, ReturnType<typeof useSupplierAction>> = {
    deactivate: useSupplierAction('deactivate'),
    activate: useSupplierAction('activate'),
    archive: useSupplierAction('archive'),
    restore: useSupplierAction('restore'),
    blacklist: useSupplierAction('blacklist'),
  };
  const fail = (e: Error) => showToast(e.message, 'error');

  function runAction(s: Supplier, action: SupplierAction) {
    const question = CONFIRM[action];
    if (question && !confirm(question(s.name))) return;
    actions[action].mutate(s.id, { onSuccess: () => showToast(DONE[action], 'success'), onError: fail });
  }

  function remove(s: Supplier) {
    if (!confirm(`Delete "${s.name}"?`)) return;
    deleteMut.mutate(s.id, {
      onSuccess: () => showToast('Deleted', 'success'),
      onError: (e: Error) => {
        const details = (e as Error & { details?: Record<string, unknown> }).details;
        // The supplier's DEPENDENCY_CONFLICT error carries { poCount }, not the
        // usage map the catalog usage endpoints return, so normalize it here.
        if (details && 'poCount' in details) setDepDialog({ supplier: s, usage: { purchaseOrders: details.poCount as number } });
        else fail(e);
      },
    });
  }

  function save(body: CreateSupplierRequest) {
    const done = (message: string) => () => { setDrawer(null); showToast(message, 'success'); };
    const editing = drawer?.editing;
    if (editing) updateMut.mutate({ id: editing.id, body }, { onSuccess: done('Supplier updated'), onError: fail });
    else createMut.mutate(body, { onSuccess: done('Supplier created'), onError: fail });
  }

  const suppliers = data?.items ?? [];
  const writable = canWrite(userRole, userPermissions);

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="text" placeholder="Search suppliers..." value={q} onChange={e => { setQ(e.target.value); setPage(1); }} className={`${FILTER} w-56 focus:outline-hidden focus:ring-2 focus:ring-blue-500`} />
        <select value={filterType} onChange={e => { setFilterType(e.target.value as typeof filterType); setPage(1); }} className={FILTER}><option value="">All Types</option><option value="external">External</option><option value="publisher">Publisher</option></select>
        <StatusFilter value={statusFilter} onChange={v => { setStatusFilter(v); setPage(1); }} />
        <select value={filterBlacklisted} onChange={e => { setFilterBlacklisted(e.target.value as typeof filterBlacklisted); setPage(1); }} className={FILTER}><option value="">All</option><option value="false">Not Blacklisted</option><option value="true">Blacklisted</option></select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} suppliers</span>
          {writable && <button onClick={() => setDrawer({ editing: null })} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ New Supplier</button>}
        </div>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : suppliers.length === 0 ? <div className="p-8 text-center text-gray-400">No suppliers found.</div> : (
          <SupplierTable
            suppliers={suppliers}
            canWrite={writable}
            canModerate={canBlacklist(userRole, userPermissions)}
            onEdit={s => setDrawer({ editing: s })}
            onAction={runAction}
            onDelete={remove}
          />
        )}
        {data && (
          <Pagination
            page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="supplier"
          />
        )}
      </div>
      {drawer && (
        <SupplierForm
          key={drawer.editing?.id ?? 'new'}
          editing={drawer.editing}
          busy={createMut.isPending || updateMut.isPending}
          onSubmit={save}
          onClose={() => setDrawer(null)}
        />
      )}
      {depDialog && (
        <DependencyDialog
          entityName={depDialog.supplier.name}
          usage={depDialog.usage}
          onClose={() => setDepDialog(null)}
          onArchive={() => { actions.archive.mutate(depDialog.supplier.id, { onSuccess: () => showToast(DONE.archive, 'success'), onError: fail }); setDepDialog(null); }}
          archiving={actions.archive.isPending}
        />
      )}
    </div>
  );
}
