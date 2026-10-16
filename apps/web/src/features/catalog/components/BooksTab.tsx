import { useEffect, useState } from 'react';
import type { Book } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { StatusBadge, StatusFilter, type StatusFilterValue } from '../../../components/StatusFilter.js';
import { DependencyDialog } from '../../../components/DependencyDialog.js';
import { Drawer } from '../../../shared/components/Drawer.js';
import { SearchPicker, type PickerOption } from '../../../shared/components/SearchPicker.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { listReference } from '../../catalogReference/api.js';
import type { BookAction, BookListParams } from '../api.js';
import { useActiveBookCount, useBookAction, useBooks, useBulkBookAction, useDeleteBook, useRefreshBooks } from '../queries.js';
import { canDeleteFromCatalog, canEditCatalog } from '../rules.js';
import { BookFormDrawer } from './BookFormDrawer.js';
import { RowMenu } from './RowMenu.js';

type SortBy = NonNullable<BookListParams['sortBy']>;

const GENRES = ['Fiction', 'Non-Fiction', 'Science Fiction', 'Fantasy', 'Mystery', 'Biography', 'History', 'Self-Help', 'Children'];
const PAGE_SIZE = 25;
const FILTER = 'px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const DONE: Record<BookAction, string> = { deactivate: 'Deactivated', reactivate: 'Reactivated', archive: 'Book archived', restore: 'Book restored' };

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A book without an ISBN is stored under a placeholder, which is not shown. */
const shownIsbn = (isbn: string) => (isbn.startsWith('SKU-') || isbn.startsWith('AUTO-') ? '—' : isbn);

// The filters live in the address, so a filtered list can be shared or reloaded.
const getParam = (key: string) => new URLSearchParams(window.location.search).get(key) ?? '';
function setParams(updates: Record<string, string>) {
  const p = new URLSearchParams(window.location.search);
  Object.entries(updates).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
  window.history.replaceState(null, '', `?${p.toString()}`);
}

/** A picker for a filter kept by name: active authors or categories whose name starts with what is typed. */
function NameFilter({ kind, value, onChange, placeholder }: {
  kind: 'authors' | 'categories'; value: string; onChange: (name: string) => void; placeholder: string;
}) {
  const option: PickerOption | null = value ? { id: 0, label: value } : null;
  return (
    <div className="w-[160px]">
      <SearchPicker
        aria-label={placeholder}
        value={option}
        onChange={(o) => onChange(o?.label ?? '')}
        queryKey={kind}
        search={async (q) => (await listReference(kind, { q, pageSize: 20 })).items.map((r) => ({ id: r.id, label: r.name }))}
        placeholder={placeholder}
        className={`w-full ${FILTER}`}
      />
    </div>
  );
}

/** The book list: filters, sorting, paging, bulk status changes and each book's actions. */
export function BooksTab() {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const canEdit = canEditCatalog(me);
  const canDelete = canDeleteFromCatalog(me);
  const currency = useCurrency();
  const fmt = (n: number | null | undefined) => (n != null ? `${currency} ${n.toFixed(2)}` : '—');

  const [searchRaw, setSearchRaw] = useState(() => getParam('q'));
  const search = useDebounce(searchRaw.trim(), 300);
  const [genre, setGenre] = useState(() => getParam('genre'));
  const [status, setStatus] = useState<StatusFilterValue>(() => (getParam('status') as StatusFilterValue) || 'active');
  const [category, setCategory] = useState(() => getParam('cat'));
  const [author, setAuthor] = useState(() => getParam('author'));
  const [tagRaw, setTagRaw] = useState(() => getParam('tag'));
  const tag = useDebounce(tagRaw.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [sortBy, setSortBy] = useState<SortBy>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [advOpen, setAdvOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [form, setForm] = useState<{ book: Book | null } | null>(null);
  const [detail, setDetail] = useState<Book | null>(null);
  const [depDialog, setDepDialog] = useState<{ book: Book; usage: Record<string, number> } | null>(null);

  useEffect(() => {
    setParams({ q: search, genre, status: status === 'active' ? '' : status, cat: category, author, tag });
  }, [search, genre, status, category, author, tag]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [search, genre, status, category, author, tag]);

  // The API finds a title, author, SKU or publisher in part, and an exact ISBN-10 or ISBN-13, from `q`.
  const params: BookListParams = {
    q: search || undefined, genre: genre || undefined, category: category || undefined, author: author || undefined,
    tag: tag || undefined, status, sortBy, sortDir, page, pageSize,
  };
  const { data, isLoading, isFetching } = useBooks(params);
  const { data: activeCount } = useActiveBookCount();
  const books = data?.items ?? [];
  const total = data?.total ?? 0;

  const refresh = useRefreshBooks();
  const actions: Record<BookAction, ReturnType<typeof useBookAction>> = {
    deactivate: useBookAction('deactivate'),
    reactivate: useBookAction('reactivate'),
    archive: useBookAction('archive'),
    restore: useBookAction('restore'),
  };
  const bulk = { reactivate: useBulkBookAction('reactivate'), deactivate: useBulkBookAction('deactivate') };
  const remove = useDeleteBook();
  const fail = (e: Error) => showToast(e.message, 'error');

  function run(book: Book, action: BookAction) {
    if (action === 'archive' && !confirm(`Archive "${book.title}"?`)) return;
    actions[action].mutate(book.id, { onSuccess: () => showToast(DONE[action], 'success'), onError: fail });
  }

  function del(book: Book) {
    if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
    remove.mutate(book.id, {
      onSuccess: () => showToast('Book deleted', 'success'),
      onError: (e: Error) => {
        const details = (e as Error & { details?: Record<string, number> }).details;
        if (details) setDepDialog({ book, usage: details });
        else fail(e);
      },
    });
  }

  function runBulk(action: 'reactivate' | 'deactivate') {
    const done = action === 'reactivate' ? 'reactivated' : 'deactivated';
    bulk[action].mutate([...selected], {
      onSuccess: ({ done: ok, refused }) => {
        // The books the API refused stay selected, to be looked at again.
        setSelected(new Set(refused.map((r) => r.id)));
        if (refused.length === 0) showToast(`${ok.length} ${done}`, 'success');
        else showToast(`${ok.length} of ${ok.length + refused.length} ${done}; ${refused.length} refused: ${refused[0].message}`, 'error');
      },
    });
  }

  const allIds = books.map((b) => b.id);
  const allSel = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSel ? new Set() : new Set(allIds));
  const toggleOne = (id: number) => setSelected((prev) => {
    const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s;
  });
  const doSort = (col: SortBy) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  };
  const hasFilters = !!(search || genre || status !== 'active' || category || author || tag);
  const clearAll = () => { setSearchRaw(''); setGenre(''); setStatus('active'); setCategory(''); setAuthor(''); setTagRaw(''); setPage(1); };
  const advCount = [genre, category, author, tag].filter(Boolean).length;
  const cols = canEdit ? 9 : 8;
  const bulkBusy = bulk.reactivate.isPending || bulk.deactivate.isPending;

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-3 pr-3 border-r border-gray-200 dark:border-gray-700 shrink-0">
          <span className="text-xs text-gray-500 dark:text-gray-400">Total <span className="font-semibold text-gray-900 dark:text-white">{data?.total ?? '—'}</span></span>
          <span className="text-xs text-gray-500 dark:text-gray-400">Active <span className="font-semibold text-emerald-600 dark:text-emerald-400">{activeCount ?? '—'}</span></span>
        </div>

        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={searchRaw} onChange={(e) => setSearchRaw(e.target.value)} placeholder="Search title, author, ISBN, SKU…"
            className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
          {searchRaw && <button type="button" aria-label="Clear search" onClick={() => setSearchRaw('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕</button>}
        </div>

        <NameFilter kind="categories" value={category} onChange={setCategory} placeholder="All Categories" />
        <NameFilter kind="authors" value={author} onChange={setAuthor} placeholder="All Authors" />

        <select aria-label="Genre" value={genre} onChange={(e) => setGenre(e.target.value)} className={FILTER}>
          <option value="">All Genres</option>
          {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>

        <StatusFilter value={status} onChange={setStatus} />

        <button type="button" aria-label="More filters" onClick={() => setAdvOpen(true)}
          className={`flex items-center gap-1 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${advCount > 0 ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
          ⚙ {advCount > 0 && <span className="px-1 py-0.5 bg-blue-600 text-white text-xs rounded-full leading-none">{advCount}</span>}
        </button>

        {hasFilters && <button type="button" onClick={clearAll} className="text-xs text-gray-400 hover:text-red-500 transition-colors whitespace-nowrap">Reset</button>}
        <div className="flex-1" />
        <span className="text-xs text-gray-400 whitespace-nowrap">{isLoading ? '…' : `${total} books`}{isFetching && !isLoading && ' ↻'}</span>
        {canEdit && (
          <button type="button" onClick={() => setForm({ book: null })}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0">
            + Add Book
          </button>
        )}
      </div>
      {canEdit && selected.size > 0 && (
        <div className="bg-blue-600 text-white px-6 py-2 flex items-center gap-4 shrink-0 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <button type="button" disabled={bulkBusy} onClick={() => runBulk('reactivate')} className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg disabled:opacity-50">Activate</button>
          <button type="button" disabled={bulkBusy} onClick={() => runBulk('deactivate')} className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg disabled:opacity-50">Deactivate</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-white/70 hover:text-white">✕ Clear</button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              {canEdit && <th className="w-10 px-4 py-3"><input type="checkbox" aria-label="Select all" checked={allSel} onChange={toggleAll} className="rounded-sm border-gray-300 dark:border-gray-600 text-blue-600" /></th>}
              <SortTh label="Title" col="title" sortBy={sortBy} sortDir={sortDir} onSort={doSort} />
              <SortTh label="ISBN / SKU" col="isbn" sortBy={sortBy} sortDir={sortDir} onSort={doSort} />
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Authors</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Categories</th>
              <SortTh label="Price" col="default_price" sortBy={sortBy} sortDir={sortDir} onSort={doSort} align="right" />
              <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
              <SortTh label="Added" col="created_at" sortBy={sortBy} sortDir={sortDir} onSort={doSort} />
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? [...Array(6)].map((_, i) => <SkeletonRow key={i} cols={cols} />) :
             books.length === 0 ? (
              <tr><td colSpan={cols} className="px-4 py-16 text-center">
                <div className="flex flex-col items-center gap-3">
                  <span className="text-4xl">📚</span>
                  <p className="text-gray-500 dark:text-gray-400">{hasFilters ? 'No books match your filters' : 'No books yet'}</p>
                  {hasFilters ? <button type="button" onClick={clearAll} className="text-sm text-blue-600 hover:underline">Clear filters</button>
                    : canEdit ? <button type="button" onClick={() => setForm({ book: null })} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg">Add your first book</button> : null}
                </div>
              </td></tr>
            ) : books.map((book) => (
              <tr key={book.id} className={`hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors group ${selected.has(book.id) ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
                {canEdit && <td className="px-4 py-3"><input type="checkbox" aria-label={`Select ${book.title}`} checked={selected.has(book.id)} onChange={() => toggleOne(book.id)} className="rounded-sm border-gray-300 dark:border-gray-600 text-blue-600" /></td>}
                <td className="px-4 py-3 max-w-[200px]">
                  <button type="button" onClick={() => setDetail(book)} className="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left line-clamp-2 text-sm">{book.title}</button>
                </td>
                <td className="px-4 py-3">
                  <div className="font-mono text-xs text-gray-600 dark:text-gray-400">{shownIsbn(book.isbn)}</div>
                  {book.sku && <div className="text-xs text-gray-400 mt-0.5">SKU: {book.sku}</div>}
                </td>
                <td className="px-4 py-3 max-w-[140px]">
                  <span className="text-xs text-gray-700 dark:text-gray-300">{book.authors[0] ?? '—'}{book.authors.length > 1 && <span className="text-gray-400 ml-1">+{book.authors.length - 1}</span>}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {book.categories.slice(0, 2).map((c) => <span key={c} className="text-xs px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 rounded-sm">{c}</span>)}
                    {book.categories.length > 2 && <span className="text-xs text-gray-400">+{book.categories.length - 2}</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">{fmt(book.defaultPrice)}</td>
                <td className="px-4 py-3 text-center"><StatusBadge status={book.status} /></td>
                <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(book.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <RowMenu items={[
                    { label: 'View details', icon: '👁', onClick: () => setDetail(book) },
                    ...(canEdit ? [
                      { label: 'Edit', icon: '✏️', onClick: () => setForm({ book }) },
                      book.status === 'ACTIVE'
                        ? { label: 'Deactivate', icon: '🚫', onClick: () => run(book, 'deactivate'), danger: true }
                        : { label: 'Activate', icon: '✅', onClick: () => run(book, 'reactivate') },
                      book.status === 'ARCHIVED'
                        ? { label: 'Restore', icon: '📤', onClick: () => run(book, 'restore') }
                        : { label: 'Archive', icon: '🗄️', onClick: () => run(book, 'archive') },
                    ] : []),
                    ...(canDelete ? [{ label: 'Delete', icon: '🗑️', onClick: () => del(book), danger: true }] : []),
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-white dark:bg-gray-900 shrink-0">
        <Pagination page={page} pageSize={pageSize} total={total} totalPages={data?.totalPages ?? 0}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="book" />
      </div>
      {advOpen && (
        <Drawer title="More Filters" onClose={() => setAdvOpen(false)}
          footer={<DrawerButton variant="secondary" onClick={() => setAdvOpen(false)}>Close</DrawerButton>}>
          <div className="space-y-5">
            <p className="text-xs text-gray-500 dark:text-gray-400">Additional filters. Category, Author, Genre, and Status are available in the main filter bar.</p>
            <div>
              <label htmlFor="book-tag-filter" className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Tag</label>
              <input id="book-tag-filter" value={tagRaw} onChange={(e) => setTagRaw(e.target.value)} placeholder="e.g. bestseller"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            </div>
          </div>
        </Drawer>
      )}
      {detail && (
        <Drawer title={detail.title} onClose={() => setDetail(null)}
          footer={canEdit ? <DrawerButton onClick={() => { setForm({ book: detail }); setDetail(null); }}>Edit Book</DrawerButton> : undefined}>
          <BookDetail book={detail} price={fmt(detail.defaultPrice)} />
        </Drawer>
      )}
      {form && (
        <BookFormDrawer book={form.book} currency={currency}
          onClose={() => setForm(null)}
          onSaved={() => { void refresh(); setForm(null); }}
          showToast={showToast} />
      )}
      {depDialog && (
        <DependencyDialog
          entityName={depDialog.book.title}
          usage={depDialog.usage}
          onClose={() => setDepDialog(null)}
          onArchive={() => { actions.archive.mutate(depDialog.book.id, { onSuccess: () => showToast(DONE.archive, 'success'), onError: fail }); setDepDialog(null); }}
          archiving={actions.archive.isPending}
        />
      )}
    </div>
  );
}

function BookDetail({ book, price }: { book: Book; price: string }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-gray-400">Added {fmtDate(book.createdAt)}</p>
      <DRow label="ISBN" value={shownIsbn(book.isbn)} mono />
      {book.sku && <DRow label="SKU" value={book.sku} mono />}
      <DRow label="Authors" value={book.authors.join(', ') || '—'} />
      {book.publisher && <DRow label="Publisher" value={book.publisher} />}
      {book.genre && <DRow label="Genre" value={book.genre} />}
      {book.edition && <DRow label="Edition" value={book.edition} />}
      {book.language && <DRow label="Language" value={book.language} />}
      {book.format && <DRow label="Format" value={book.format} />}
      <DRow label="Default Price" value={price} />
      {book.categories.length > 0 && (
        <div className="flex gap-2">
          <span className="text-gray-500 dark:text-gray-400 w-28 shrink-0 text-xs">Categories</span>
          <div className="flex flex-wrap gap-1">{book.categories.map((c) => <span key={c} className="text-xs px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full">{c}</span>)}</div>
        </div>
      )}
      {book.tags.length > 0 && (
        <div className="flex gap-2">
          <span className="text-gray-500 dark:text-gray-400 w-28 shrink-0 text-xs">Tags</span>
          <div className="flex flex-wrap gap-1">{book.tags.map((t) => <span key={t} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">{t}</span>)}</div>
        </div>
      )}
      {book.description && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</p>
          <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">{book.description}</p>
        </div>
      )}
    </div>
  );
}

function SortTh({ label, col, sortBy, sortDir, onSort, align = 'left' }: {
  label: string; col: SortBy; sortBy: SortBy; sortDir: 'asc' | 'desc'; onSort: (c: SortBy) => void; align?: 'left' | 'right';
}) {
  const active = sortBy === col;
  return (
    <th className={`px-4 py-3 text-${align}`} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(col)}
        className={`flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors ${align === 'right' ? 'ml-auto' : ''} ${active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
        {label} <span className="text-xs">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
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

function DRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 dark:text-gray-400 w-28 shrink-0 text-xs">{label}</span>
      <span className={`text-gray-800 dark:text-gray-200 text-xs ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function DrawerButton({ children, onClick, variant = 'primary' }: { children: React.ReactNode; onClick: () => void; variant?: 'primary' | 'secondary' }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${variant === 'primary' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>
      {children}
    </button>
  );
}
