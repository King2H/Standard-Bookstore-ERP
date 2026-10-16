import { useEffect, useState } from 'react';
import type { Category } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { StatusBadge, StatusFilter, type StatusFilterValue } from '../../../components/StatusFilter.js';
import { DependencyDialog } from '../../../components/DependencyDialog.js';
import { useMyProfile } from '../../account/queries.js';
import { canDeleteFromCatalog, canEditCatalog } from '../../catalog/rules.js';
import type { ReferenceAction, ReferenceKind, ReferenceRecord } from '../api.js';
import { useDeleteReference, useReferenceAction, useReferenceList, useSaveReference } from '../queries.js';
import { ReferenceForm, type ReferenceFormSave } from './ReferenceForm.js';

type Item = ReferenceRecord[ReferenceKind];

const KINDS: Record<ReferenceKind, { title: string; noun: string; icon: string; placeholder: string }> = {
  authors: { title: 'Authors', noun: 'Author', icon: '✍️', placeholder: 'e.g. George Orwell' },
  categories: { title: 'Categories', noun: 'Category', icon: '🏷️', placeholder: 'e.g. Science Fiction' },
  publishers: { title: 'Publishers', noun: 'Publisher', icon: '🏢', placeholder: 'e.g. Penguin Books' },
};

const DONE: Record<ReferenceAction, string> = { deactivate: 'Deactivated', activate: 'Activated', archive: 'Archived', restore: 'Restored' };

const PAGE_SIZE = 25;

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const parentOf = (item: Item) => ('parentId' in item ? { parentId: item.parentId, parentName: item.parentName } : {});

/** The list of one kind of reference data, with search, status filter, paging and its actions. */
export function ReferenceTab({ kind }: { kind: ReferenceKind }) {
  const { title, noun, icon, placeholder } = KINDS[kind];
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const canEdit = canEditCatalog(me);
  const canDelete = canDeleteFromCatalog(me);

  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounce(searchRaw, 300);
  const [status, setStatus] = useState<StatusFilterValue>('active');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [form, setForm] = useState<{ editing: Item | null } | null>(null);
  const [formError, setFormError] = useState('');
  const [depDialog, setDepDialog] = useState<{ item: Item; usage: Record<string, number> } | null>(null);
  useEffect(() => setPage(1), [search, status]);

  const { data, isLoading } = useReferenceList(kind, { q: search, status, page, pageSize });
  const items: Item[] = data?.items ?? [];
  const total = data?.total ?? 0;

  const save = useSaveReference(kind);
  const remove = useDeleteReference(kind);
  const actions: Record<ReferenceAction, ReturnType<typeof useReferenceAction>> = {
    deactivate: useReferenceAction(kind, 'deactivate'),
    activate: useReferenceAction(kind, 'activate'),
    archive: useReferenceAction(kind, 'archive'),
    restore: useReferenceAction(kind, 'restore'),
  };
  const fail = (e: Error) => showToast(e.message, 'error');

  function run(item: Item, action: ReferenceAction) {
    if (action === 'archive' && !confirm(`Archive "${item.name}"?`)) return;
    actions[action].mutate(item.id, { onSuccess: () => showToast(DONE[action], 'success'), onError: fail });
  }

  function del(item: Item) {
    if (!confirm(`Delete "${item.name}"?`)) return;
    remove.mutate(item.id, {
      onSuccess: () => showToast('Deleted', 'success'),
      onError: (e: Error) => {
        const details = (e as Error & { details?: Record<string, number> }).details;
        if (details) setDepDialog({ item, usage: details });
        else fail(e);
      },
    });
  }

  function onSave(values: ReferenceFormSave) {
    const editing = form?.editing ?? null;
    setFormError('');
    save.mutate({ id: editing?.id ?? null, ...values }, {
      onSuccess: () => { showToast(editing ? 'Updated' : 'Created', 'success'); setForm(null); },
      onError: (e: Error) => setFormError(e.message),
    });
  }

  const openForm = (editing: Item | null) => { setFormError(''); setForm({ editing }); };
  const columns = ['Name', ...(kind === 'categories' ? ['Parent'] : []), 'Status', 'Books', 'Added', ''];

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center gap-4 shrink-0">
        <span className="text-lg">{icon}</span>
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
          {data && <p className="text-xs text-gray-400">{total} {title.toLowerCase()}</p>}
        </div>
        <div className="flex-1 max-w-xs">
          <input value={searchRaw} onChange={e => setSearchRaw(e.target.value)} placeholder={`Search ${title.toLowerCase()}…`}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        </div>
        <StatusFilter value={status} onChange={setStatus} />
        <div className="flex-1" />
        {canEdit && (
          <button type="button" onClick={() => openForm(null)} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            + Add {noun}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              {columns.map((col, i) => (
                <th key={i} className={`px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide ${i === columns.length - 1 ? 'text-right' : 'text-left'}`}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? [...Array(5)].map((_, i) => <SkeletonRow key={i} cols={columns.length} />) :
             items.length === 0 ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">No {title.toLowerCase()} found</td></tr>
            ) : items.map(item => (
              <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3"><span className="font-medium text-gray-900 dark:text-white text-sm">{item.name}</span></td>
                {kind === 'categories' && <td className="px-4 py-3"><span className="text-gray-500 text-xs">{(item as Category).parentName ?? '—'}</span></td>}
                <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                <td className="px-4 py-3"><span className="text-gray-500 text-sm">{item.bookCount ?? 0}</span></td>
                <td className="px-4 py-3"><span className="text-gray-400 text-xs">{fmtDate(item.createdAt)}</span></td>
                <td className="px-4 py-3 text-right">
                  {canEdit && (
                    <div className="flex gap-3 justify-end">
                      <button type="button" onClick={() => openForm(item)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                      {item.status === 'ACTIVE'
                        ? <button type="button" onClick={() => run(item, 'deactivate')} className="text-xs text-yellow-600 dark:text-yellow-400 hover:underline">Deactivate</button>
                        : item.status === 'INACTIVE' && <button type="button" onClick={() => run(item, 'activate')} className="text-xs text-green-600 dark:text-green-400 hover:underline">Activate</button>}
                      {item.status === 'ARCHIVED'
                        ? <button type="button" onClick={() => run(item, 'restore')} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Restore</button>
                        : <button type="button" onClick={() => run(item, 'archive')} className="text-xs text-amber-600 dark:text-amber-400 hover:underline">Archive</button>}
                      {canDelete && <button type="button" onClick={() => del(item)} className="text-xs text-red-500 hover:underline">Delete</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-white dark:bg-gray-900 shrink-0">
        <Pagination page={page} pageSize={pageSize} total={total} totalPages={Math.ceil(total / pageSize)}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
          itemLabel={noun.toLowerCase()} itemPlural={title.toLowerCase()} />
      </div>
      {form && (
        <ReferenceForm kind={kind} noun={noun} placeholder={placeholder}
          editing={form.editing && { id: form.editing.id, name: form.editing.name, ...parentOf(form.editing) }}
          saving={save.isPending} error={formError} onSave={onSave} onClose={() => setForm(null)} />
      )}
      {depDialog && (
        <DependencyDialog
          entityName={depDialog.item.name}
          usage={depDialog.usage}
          onClose={() => setDepDialog(null)}
          onArchive={() => { actions.archive.mutate(depDialog.item.id, { onSuccess: () => showToast(DONE.archive, 'success'), onError: fail }); setDepDialog(null); }}
          archiving={actions.archive.isPending}
        />
      )}
    </div>
  );
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse">
      {[...Array(cols)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-sm" style={{ width: `${50 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}
