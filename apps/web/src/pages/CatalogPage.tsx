// CatalogPage — Master-data ERP catalog
// Sub-navigation: Books | Authors | Categories | Publishers
import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
type Tab = 'books' | 'authors' | 'categories' | 'publishers';

interface Book {
  id: number; isbn: string; sku: string | null; title: string;
  authors: string[]; authorIds: number[]; genre: string | null;
  publisher: string | null; publisherId: number | null;
  formatId: number | null; formatCode: string | null; formatLabel: string | null;
  editionId: number | null; editionCode: string | null; editionLabel: string | null;
  edition: string | null; language: string | null; format: string | null;
  description: string | null; defaultPrice: number | null; tradeValue: number | null;
  isActive: boolean; createdAt: string; categories: string[]; categoryIds: number[]; tags: string[];
}
interface BookList { items: Book[]; total: number; page: number; totalPages: number; }
interface Author { id: number; name: string; bookCount?: number; createdAt: string; }
interface AuthorList { items: Author[]; total: number; }
interface Category { id: number; name: string; parentId: number | null; parentName?: string | null; bookCount?: number; createdAt: string; }
interface CategoryList { items: Category[]; total: number; }
interface Publisher { id: number; name: string; bookCount?: number; createdAt: string; }
interface PublisherList { items: Publisher[]; total: number; }
interface BookFormat { id: number; code: string; label: string; sortOrder: number; }
interface BookEdition { id: number; code: string; label: string; sortOrder: number; }
interface ConfigRow { key: string; value: unknown; }

const canWrite = (role: Role | undefined, perms?: string[]) =>
  (perms && perms.includes('MANAGE_INVENTORY')) ||
  role === 'Admin' || role === 'Manager' || role === 'Stock_Clerk';

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function validateIsbn13(isbn: string): boolean {
  const d = isbn.replace(/[-\s]/g, '');
  if (!/^\d{13}$/.test(d)) return false;
  return d.split('').reduce((a, c, i) => a + parseInt(c, 10) * (i % 2 === 0 ? 1 : 3), 0) % 10 === 0;
}

export default function CatalogPage({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const [tab, setTab] = useState<Tab>('books');
  const tabs = [
    { id: 'books' as Tab, label: 'Books', icon: '📖' },
    { id: 'authors' as Tab, label: 'Authors', icon: '✍️' },
    { id: 'categories' as Tab, label: 'Categories', icon: '🏷️' },
    { id: 'publishers' as Tab, label: 'Publishers', icon: '🏢' },
  ];
  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 flex gap-1 flex-shrink-0">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'books' && <BooksTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'authors' && <AuthorsTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'categories' && <CategoriesTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'publishers' && <PublishersTab userRole={userRole} userPermissions={userPermissions} />}
      </div>
    </div>
  );
}


// ── BooksTab ──────────────────────────────────────────────────────────────────
function BooksTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const { showToast } = useToast();

  // ── URL-synced filter state ───────────────────────────────────────────────
  const getParam = (key: string) => new URLSearchParams(window.location.search).get(key) ?? '';
  const setParam = (updates: Record<string, string>) => {
    const p = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([k, v]) => v ? p.set(k, v) : p.delete(k));
    window.history.replaceState(null, '', `?${p.toString()}`);
  };

  const [searchRaw, setSearchRaw] = useState(() => getParam('q'));
  const search = useDebounce(searchRaw, 300);
  const [genre, setGenre] = useState(() => getParam('genre'));
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>(() => (getParam('status') as 'active' | 'inactive' | 'all') || 'active');
  const [catId, setCatId] = useState<string>(() => getParam('cat'));
  const [authorId, setAuthorId] = useState<string>(() => getParam('author'));
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<'title' | 'isbn' | 'created_at' | 'default_price'>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [advOpen, setAdvOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editBook, setEditBook] = useState<Book | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailBook, setDetailBook] = useState<Book | null>(null);

  // Sync filters to URL
  useEffect(() => { setParam({ q: search, genre, status: status === 'active' ? '' : status, cat: catId, author: authorId }); }, [search, genre, status, catId, authorId]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [search, genre, status, catId, authorId]);

  const { data: cfgData } = useQuery<{ items: ConfigRow[] }>({
    queryKey: ['config-system'], queryFn: () => api.get('/config/system'), staleTime: 300_000,
  });
  const currency = (cfgData?.items.find(r => r.key === 'base_currency')?.value as string) ?? 'ETB';
  const fmt = (n: number | null | undefined) => n != null ? `${currency} ${n.toFixed(2)}` : '—';

  const buildParams = () => {
    const p = new URLSearchParams();
    if (search) {
      const raw = search.replace(/[-\s]/g, '');
      // Pure 10-13 digits → exact ISBN match
      if (/^\d{10,13}$/.test(raw)) {
        p.set('isbn', raw);
      // Looks like SKU: short alphanumeric starting with letters (e.g. "BK-001", "SKU123")
      } else if (/^[A-Z]{2,5}[-_]?\d+$/i.test(search.trim())) {
        p.set('sku', search.trim());
      // Everything else → full-text search (title, author)
      } else {
        p.set('q', search);
      }
    }
    if (genre) p.set('genre', genre);
    if (catId) p.set('category', catId);
    if (authorId) p.set('author', authorId);
    if (status === 'active') p.set('is_active', 'true');
    else if (status === 'inactive') p.set('is_active', 'false');
    p.set('sortBy', sortBy); p.set('sortDir', sortDir);
    p.set('page', String(page)); p.set('pageSize', '25');
    return p.toString();
  };

  const { data, isLoading, isFetching } = useQuery<BookList>({
    queryKey: ['books', search, genre, catId, authorId, status, sortBy, sortDir, page],
    queryFn: () => api.get<BookList>(`/books?${buildParams()}`),
    placeholderData: prev => prev,
  });
  const { data: kpi } = useQuery<BookList>({
    queryKey: ['books-kpi'], queryFn: () => api.get<BookList>('/books?is_active=true&pageSize=1'), staleTime: 30_000,
  });
  const { data: catData } = useQuery<CategoryList>({
    queryKey: ['categories', ''], queryFn: () => api.get<CategoryList>('/categories?pageSize=200'), staleTime: 60_000,
  });
  const { data: authorData } = useQuery<AuthorList>({
    queryKey: ['authors', ''], queryFn: () => api.get<AuthorList>('/authors?pageSize=200'), staleTime: 60_000,
  });
  const allCats = catData?.items ?? [];
  const allAuthors = authorData?.items ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['books'] });
    qc.invalidateQueries({ queryKey: ['books-kpi'] });
  };
  const deactivate = useMutation({
    mutationFn: (id: number) => api.post(`/books/${id}/deactivate`),
    onSuccess: () => { invalidate(); showToast('Deactivated', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const reactivate = useMutation({
    mutationFn: (id: number) => api.post(`/books/${id}/reactivate`),
    onSuccess: () => { invalidate(); showToast('Reactivated', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const allIds = data?.items.map(b => b.id) ?? [];
  const allSel = allIds.length > 0 && allIds.every(id => selected.has(id));
  const toggleAll = () => setSelected(allSel ? new Set() : new Set(allIds));
  const toggleOne = (id: number) => setSelected(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s;
  });
  // doSort accepts string to match SortTh's onSort: (c: string) => void
  const doSort = (col: string) => {
    const c = col as typeof sortBy;
    if (sortBy === c) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(c); setSortDir('asc'); }
    setPage(1);
  };
  const hasFilters = !!(search || genre || status !== 'active' || catId || authorId);
  const clearAll = () => { setSearchRaw(''); setGenre(''); setStatus('active'); setCatId(''); setAuthorId(''); setPage(1); };
  const advCount = [genre, catId, authorId].filter(Boolean).length;


  return (
    <div className="flex flex-col h-full">
      {/* Compact toolbar: stats + search + filters + add button all in one row */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap">
        {/* KPI chips */}
        <div className="flex items-center gap-3 pr-3 border-r border-gray-200 dark:border-gray-700 flex-shrink-0">
          <span className="text-xs text-gray-500 dark:text-gray-400">Total <span className="font-semibold text-gray-900 dark:text-white">{data?.total ?? '—'}</span></span>
          <span className="text-xs text-gray-500 dark:text-gray-400">Active <span className="font-semibold text-emerald-600 dark:text-emerald-400">{kpi?.total ?? '—'}</span></span>
        </div>

        {/* Debounced search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={searchRaw} onChange={e => setSearchRaw(e.target.value)} placeholder="Search title, author, ISBN, SKU…"
            className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {searchRaw && <button onClick={() => setSearchRaw('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕</button>}
        </div>

        {/* Category dropdown */}
        <select value={catId} onChange={e => { setCatId(e.target.value); setPage(1); }}
          className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[160px]">
          <option value="">All Categories</option>
          {allCats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>

        {/* Author dropdown */}
        <select value={authorId} onChange={e => { setAuthorId(e.target.value); setPage(1); }}
          className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[160px]">
          <option value="">All Authors</option>
          {allAuthors.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
        </select>

        {/* Genre */}
        <select value={genre} onChange={e => { setGenre(e.target.value); setPage(1); }}
          className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Genres</option>
          {['Fiction','Non-Fiction','Science Fiction','Fantasy','Mystery','Biography','History','Self-Help','Children'].map(g => <option key={g} value={g}>{g}</option>)}
        </select>

        {/* Status */}
        <select value={status} onChange={e => { setStatus(e.target.value as typeof status); setPage(1); }}
          className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>

        {/* More filters */}
        <button onClick={() => setAdvOpen(true)}
          className={`flex items-center gap-1 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${advCount > 0 ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
          ⚙ {advCount > 0 && <span className="px-1 py-0.5 bg-blue-600 text-white text-xs rounded-full leading-none">{advCount}</span>}
        </button>

        {hasFilters && <button onClick={clearAll} className="text-xs text-gray-400 hover:text-red-500 transition-colors whitespace-nowrap">Reset</button>}
        <div className="flex-1" />
        <span className="text-xs text-gray-400 whitespace-nowrap">{isLoading ? '…' : `${data?.total ?? 0} books`}{isFetching && !isLoading && ' ↻'}</span>
        {canWrite(userRole, userPermissions) && (
          <button onClick={() => { setEditBook(null); setShowForm(true); }}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap flex-shrink-0">
            + Add Book
          </button>
        )}
      </div>
      {selected.size > 0 && (
        <div className="bg-blue-600 text-white px-6 py-2 flex items-center gap-4 flex-shrink-0 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <button onClick={async () => { for (const id of selected) await api.post(`/books/${id}/reactivate`).catch(() => null); invalidate(); setSelected(new Set()); showToast(`${selected.size} reactivated`, 'success'); }} className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg">Activate</button>
          <button onClick={async () => { for (const id of selected) await api.post(`/books/${id}/deactivate`).catch(() => null); invalidate(); setSelected(new Set()); showToast(`${selected.size} deactivated`, 'success'); }} className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg">Deactivate</button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-white/70 hover:text-white">✕ Clear</button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              <th className="w-10 px-4 py-3"><input type="checkbox" checked={allSel} onChange={toggleAll} className="rounded border-gray-300 dark:border-gray-600 text-blue-600" /></th>
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
            {isLoading ? [...Array(6)].map((_, i) => <SkeletonRow key={i} cols={9} />) :
             !data?.items.length ? (
              <tr><td colSpan={9} className="px-4 py-16 text-center">
                <div className="flex flex-col items-center gap-3">
                  <span className="text-4xl">📚</span>
                  <p className="text-gray-500 dark:text-gray-400">{hasFilters ? 'No books match your filters' : 'No books yet'}</p>
                  {hasFilters ? <button onClick={clearAll} className="text-sm text-blue-600 hover:underline">Clear filters</button>
                    : canWrite(userRole, userPermissions) ? <button onClick={() => { setEditBook(null); setShowForm(true); }} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg">Add your first book</button> : null}
                </div>
              </td></tr>
            ) : data.items.map(book => (
              <tr key={book.id} className={`hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors group ${selected.has(book.id) ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
                <td className="px-4 py-3"><input type="checkbox" checked={selected.has(book.id)} onChange={() => toggleOne(book.id)} className="rounded border-gray-300 dark:border-gray-600 text-blue-600" /></td>
                <td className="px-4 py-3 max-w-[200px]">
                  <button onClick={() => setDetailBook(book)} className="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left line-clamp-2 text-sm">{book.title}</button>
                </td>
                <td className="px-4 py-3">
                  <div className="font-mono text-xs text-gray-600 dark:text-gray-400">{book.isbn.startsWith('SKU-') || book.isbn.startsWith('AUTO-') ? '—' : book.isbn}</div>
                  {book.sku && <div className="text-xs text-gray-400 mt-0.5">SKU: {book.sku}</div>}
                </td>
                <td className="px-4 py-3 max-w-[140px]">
                  <span className="text-xs text-gray-700 dark:text-gray-300">{book.authors[0] ?? '—'}{book.authors.length > 1 && <span className="text-gray-400 ml-1">+{book.authors.length - 1}</span>}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {book.categories.slice(0, 2).map(c => <span key={c} className="text-xs px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 rounded">{c}</span>)}
                    {book.categories.length > 2 && <span className="text-xs text-gray-400">+{book.categories.length - 2}</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">{fmt(book.defaultPrice)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${book.isActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
                    {book.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(book.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <RowMenu items={[
                    { label: 'View details', icon: '👁', onClick: () => setDetailBook(book) },
                    ...(canWrite(userRole, userPermissions) ? [
                      { label: 'Edit', icon: '✏️', onClick: () => { setEditBook(book); setShowForm(true); } },
                      book.isActive
                        ? { label: 'Deactivate', icon: '🚫', onClick: () => deactivate.mutate(book.id), danger: true as const }
                        : { label: 'Reactivate', icon: '✅', onClick: () => reactivate.mutate(book.id) },
                    ] : []),
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-6 py-2.5 flex items-center justify-between flex-shrink-0">
        <span className="text-xs text-gray-500">{data ? `${(page - 1) * 25 + 1}–${Math.min(page * 25, data.total)} of ${data.total}` : '—'}</span>
        <div className="flex items-center gap-1">
          <PagBtn onClick={() => setPage(1)} disabled={page === 1} label="«" />
          <PagBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} label="‹" />
          <span className="px-3 py-1 text-xs bg-blue-600 text-white rounded font-medium">{page}</span>
          <PagBtn onClick={() => setPage(p => Math.min(data?.totalPages ?? 1, p + 1))} disabled={page === (data?.totalPages ?? 1)} label="›" />
          <PagBtn onClick={() => setPage(data?.totalPages ?? 1)} disabled={page === (data?.totalPages ?? 1)} label="»" />
        </div>
      </div>
      {advOpen && (
        <Drawer title="More Filters" onClose={() => setAdvOpen(false)}
          footer={<><Btn variant="secondary" onClick={() => { setAdvOpen(false); }}>Close</Btn></>}>
          <div className="space-y-5">
            <p className="text-xs text-gray-500 dark:text-gray-400">Additional filters. Category, Author, Genre, and Status are available in the main filter bar.</p>
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Tag</label>
              <input
                defaultValue=""
                onChange={e => { const v = e.target.value; setTimeout(() => { const p = new URLSearchParams(window.location.search); v ? p.set('tag', v) : p.delete('tag'); window.history.replaceState(null, '', `?${p.toString()}`); }, 300); }}
                placeholder="e.g. bestseller"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
            </div>
          </div>
        </Drawer>
      )}
      {detailBook && (
        <Drawer title={detailBook.title} onClose={() => setDetailBook(null)}
          footer={canWrite(userRole, userPermissions) ? <Btn onClick={() => { setEditBook(detailBook); setDetailBook(null); setShowForm(true); }}>Edit Book</Btn> : undefined}>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-gray-400">Added {fmtDate(detailBook.createdAt)}</p>
            <DRow label="ISBN" value={detailBook.isbn.startsWith('SKU-') ? '—' : detailBook.isbn} mono />
            {detailBook.sku && <DRow label="SKU" value={detailBook.sku} mono />}
            <DRow label="Authors" value={detailBook.authors.join(', ') || '—'} />
            {detailBook.publisher && <DRow label="Publisher" value={detailBook.publisher} />}
            {detailBook.genre && <DRow label="Genre" value={detailBook.genre} />}
            {detailBook.edition && <DRow label="Edition" value={detailBook.edition} />}
            {detailBook.language && <DRow label="Language" value={detailBook.language} />}
            {detailBook.format && <DRow label="Format" value={detailBook.format} />}
            <DRow label="Default Price" value={fmt(detailBook.defaultPrice)} />
            {detailBook.categories.length > 0 && (
              <div className="flex gap-2">
                <span className="text-gray-500 dark:text-gray-400 w-28 flex-shrink-0 text-xs">Categories</span>
                <div className="flex flex-wrap gap-1">{detailBook.categories.map(c => <span key={c} className="text-xs px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full">{c}</span>)}</div>
              </div>
            )}
            {detailBook.tags.length > 0 && (
              <div className="flex gap-2">
                <span className="text-gray-500 dark:text-gray-400 w-28 flex-shrink-0 text-xs">Tags</span>
                <div className="flex flex-wrap gap-1">{detailBook.tags.map(t => <span key={t} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full">{t}</span>)}</div>
              </div>
            )}
            {detailBook.description && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</p>
                <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">{detailBook.description}</p>
              </div>
            )}
          </div>
        </Drawer>
      )}
      {showForm && (
        <BookFormDrawer book={editBook} currency={currency}
          onClose={() => { setShowForm(false); setEditBook(null); }}
          onSaved={() => { invalidate(); setShowForm(false); setEditBook(null); }}
          showToast={showToast} />
      )}
    </div>
  );
}


// ── BookFormDrawer ────────────────────────────────────────────────────────────
function BookFormDrawer({ book, currency, onClose, onSaved, showToast }: {
  book: Book | null; currency: string; onClose: () => void; onSaved: () => void;
  showToast: (m: string, t: 'success' | 'error') => void;
}) {
  const [section, setSection] = useState<'basic' | 'physical' | 'authors' | 'categories' | 'pricing'>('basic');
  const [isbn, setIsbn] = useState(book ? (book.isbn.startsWith('SKU-') || book.isbn.startsWith('AUTO-') ? '' : book.isbn) : '');
  const [sku, setSku] = useState(book?.sku ?? '');
  const [title, setTitle] = useState(book?.title ?? '');
  const [authorIds, setAuthorIds] = useState<number[]>(book?.authorIds ?? []);
  const [categoryIds, setCategoryIds] = useState<number[]>(book?.categoryIds ?? []);
  const [publisherId, setPublisherId] = useState<number | null>(book?.publisherId ?? null);
  const [formatId, setFormatId] = useState<number | null>(book?.formatId ?? null);
  const [editionId, setEditionId] = useState<number | null>(book?.editionId ?? null);
  const [genre, setGenre] = useState(book?.genre ?? '');
  const [language, setLanguage] = useState(book?.language ?? '');
  const [description, setDescription] = useState(book?.description ?? '');
  const [defaultPrice, setDefaultPrice] = useState(book?.defaultPrice != null ? String(book.defaultPrice) : '');
  const [tradeValue, setTradeValue] = useState(book?.tradeValue != null ? String(book.tradeValue) : '');
  const [tags, setTags] = useState(book?.tags.join(', ') ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: authorsData } = useQuery<AuthorList>({ queryKey: ['authors', ''], queryFn: () => api.get<AuthorList>('/authors?pageSize=200'), staleTime: 60_000 });
  const { data: catsData } = useQuery<CategoryList>({ queryKey: ['categories', ''], queryFn: () => api.get<CategoryList>('/categories?pageSize=200'), staleTime: 60_000 });
  const { data: pubsData } = useQuery<PublisherList>({ queryKey: ['publishers', ''], queryFn: () => api.get<PublisherList>('/publishers?pageSize=200'), staleTime: 60_000 });
  const { data: formatsData } = useQuery<{ items: BookFormat[] }>({ queryKey: ['book-formats'], queryFn: () => api.get<{ items: BookFormat[] }>('/book-formats'), staleTime: 3600_000 });
  const { data: editionsData } = useQuery<{ items: BookEdition[] }>({ queryKey: ['book-editions'], queryFn: () => api.get<{ items: BookEdition[] }>('/book-editions'), staleTime: 3600_000 });
  const allAuthors = authorsData?.items ?? [];
  const allCats = catsData?.items ?? [];
  const allPubs = pubsData?.items ?? [];
  const allFormats = formatsData?.items ?? [];
  const allEditions = editionsData?.items ?? [];

  async function save() {
    setError('');
    if (!title.trim()) { setError('Title is required'); return; }
    if (authorIds.length === 0) { setError('At least one author is required'); return; }
    if (!formatId) { setError('Book format is required'); return; }
    if (!editionId) { setError('Edition is required'); return; }
    const rawIsbn = isbn.replace(/[-\s]/g, '');
    if (!book && rawIsbn) {
      if (!/^\d{13}$/.test(rawIsbn)) { setError('ISBN must be 13 digits'); return; }
      if (!validateIsbn13(rawIsbn)) { setError('Invalid ISBN-13 check digit'); return; }
    }
    const body = {
      ...(book ? {} : { isbn: rawIsbn || undefined }),
      sku: sku.trim() || undefined, title: title.trim(),
      authorIds, categoryIds,
      publisherId: publisherId || undefined,
      formatId, editionId,
      genre: genre || undefined,
      language: language || undefined,
      description: description || undefined,
      defaultPrice: defaultPrice ? parseFloat(defaultPrice) : undefined,
      tradeValue: tradeValue ? parseFloat(tradeValue) : undefined,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      if (book) await api.put(`/books/${book.id}`, body);
      else await api.post('/books', body);
      showToast(book ? 'Book updated' : 'Book created', 'success');
      onSaved();
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const sections = [
    { id: 'basic', label: 'Basic Info' },
    { id: 'physical', label: 'Physical' },
    { id: 'authors', label: 'Authors' },
    { id: 'categories', label: 'Categories' },
    { id: 'pricing', label: 'Pricing' },
  ] as const;

  return (
    <Drawer title={book ? 'Edit Book' : 'Add Book'} onClose={onClose}
      tabs={sections.map(s => ({ id: s.id, label: s.label }))}
      activeTab={section} onTabChange={id => setSection(id as typeof section)}
      footer={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : book ? 'Save' : 'Create'}</Btn></>}>
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300 flex gap-2">
            <span>⚠️</span><span>{error}</span>
          </div>
        )}

        {/* ── Basic Info ─────────────────────────────────────────────── */}
        {section === 'basic' && (
          <>
            <FField label="Title *" value={title} onChange={setTitle} />
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FField label="ISBN-13 (optional)" value={isbn} onChange={setIsbn} placeholder="9780306406157" disabled={!!book} />
                {!book && <p className="text-xs text-gray-400 mt-1">Leave blank to use SKU</p>}
              </div>
              <FField label="SKU / Internal ID" value={sku} onChange={setSku} placeholder="BK-001" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Publisher</label>
              <select value={publisherId ?? ''} onChange={e => setPublisherId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— No publisher —</option>
                {allPubs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FField label="Genre" value={genre} onChange={setGenre} />
              <FField label="Language" value={language} onChange={setLanguage} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </>
        )}

        {/* ── Physical Attributes ────────────────────────────────────── */}
        {section === 'physical' && (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">Format and Edition are required and affect pricing.</p>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Book Format *</label>
              <select value={formatId ?? ''} onChange={e => setFormatId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${!formatId ? 'border-amber-400 dark:border-amber-600' : 'border-gray-300 dark:border-gray-600'}`}>
                <option value="">— Select format —</option>
                {allFormats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              {!formatId && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Required</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Edition *</label>
              <select value={editionId ?? ''} onChange={e => setEditionId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${!editionId ? 'border-amber-400 dark:border-amber-600' : 'border-gray-300 dark:border-gray-600'}`}>
                <option value="">— Select edition —</option>
                {allEditions.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              {!editionId && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Required</p>}
            </div>
            {formatId && editionId && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300">
                {allFormats.find(f => f.id === formatId)?.label} · {allEditions.find(e => e.id === editionId)?.label}
                <span className="ml-2 text-blue-500">— pricing can be set per this combination in the Pricing tab</span>
              </div>
            )}
          </>
        )}

        {/* ── Authors ────────────────────────────────────────────────── */}
        {section === 'authors' && (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">Select from master list. Add new authors in the Authors tab.</p>
            <MasterSelect items={allAuthors.map(a => ({ id: a.id, label: a.name, sub: `${a.bookCount ?? 0} books` }))} selected={authorIds} onChange={setAuthorIds} placeholder="Search authors…" />
          </>
        )}

        {/* ── Categories ─────────────────────────────────────────────── */}
        {section === 'categories' && (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">Select from master list. Add new categories in the Categories tab.</p>
            <MasterSelect items={allCats.map(c => ({ id: c.id, label: c.name, sub: c.parentName ? `↳ ${c.parentName}` : undefined }))} selected={categoryIds} onChange={setCategoryIds} placeholder="Search categories…" />
            <FField label="Tags (comma-separated)" value={tags} onChange={setTags} placeholder="bestseller, award-winner…" />
          </>
        )}

        {/* ── Pricing ────────────────────────────────────────────────── */}
        {section === 'pricing' && (
          <>
            <FField label={`Default Price (${currency})`} value={defaultPrice} onChange={setDefaultPrice} type="number" />
            <FField label={`Trade Value (${currency})`} value={tradeValue} onChange={setTradeValue} type="number" />
            <p className="text-xs text-gray-400">Branch-specific and format/edition-specific overrides can be set from the book's action menu after saving.</p>
          </>
        )}
      </div>
    </Drawer>
  );
}


// ── AuthorsTab ────────────────────────────────────────────────────────────────
function AuthorsTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounce(searchRaw, 300);
  const [page, setPage] = useState(1);
  const [editItem, setEditItem] = useState<Author | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => setPage(1), [search]);

  const { data, isLoading } = useQuery<AuthorList>({
    queryKey: ['authors', search, page],
    queryFn: () => api.get<AuthorList>(`/authors?q=${encodeURIComponent(search)}&page=${page}&pageSize=25`),
    placeholderData: prev => prev,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['authors'] });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/authors/${id}`),
    onSuccess: () => { invalidate(); showToast('Author deleted', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  async function save() {
    if (!name.trim()) { setFormError('Name is required'); return; }
    setSaving(true);
    try {
      if (editItem) await api.put(`/authors/${editItem.id}`, { name: name.trim() });
      else await api.post('/authors', { name: name.trim() });
      invalidate(); showToast(editItem ? 'Updated' : 'Created', 'success'); setShowForm(false);
    } catch (e: unknown) { setFormError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <SimpleListTab title="Authors" icon="✍️" total={data?.total} searchRaw={searchRaw} onSearch={setSearchRaw}
      canWrite={canWrite(userRole, userPermissions)} onAdd={() => { setEditItem(null); setName(''); setFormError(''); setShowForm(true); }}
      isLoading={isLoading} page={page} totalPages={Math.ceil((data?.total ?? 0) / 25)} onPage={setPage}
      columns={['Name', 'Books', 'Added', '']}
      rows={(data?.items ?? []).map(a => [
        <span key="n" className="font-medium text-gray-900 dark:text-white text-sm">{a.name}</span>,
        <span key="b" className="text-gray-500 text-sm">{a.bookCount ?? 0}</span>,
        <span key="d" className="text-gray-400 text-xs">{fmtDate(a.createdAt)}</span>,
        canWrite(userRole, userPermissions) ? (
          <div key="a" className="flex gap-3 justify-end">
            <button onClick={() => { setEditItem(a); setName(a.name); setFormError(''); setShowForm(true); }} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
            <button onClick={() => { if (confirm(`Delete "${a.name}"?`)) deleteMut.mutate(a.id); }} className="text-xs text-red-500 hover:underline">Delete</button>
          </div>
        ) : null,
      ])}>
      {showForm && (
        <Drawer title={editItem ? 'Edit Author' : 'New Author'} onClose={() => setShowForm(false)}
          footer={<><Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn><Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
            <FField label="Author Name *" value={name} onChange={setName} placeholder="e.g. George Orwell" />
          </div>
        </Drawer>
      )}
    </SimpleListTab>
  );
}

// ── CategoriesTab ─────────────────────────────────────────────────────────────
function CategoriesTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounce(searchRaw, 300);
  const [page, setPage] = useState(1);
  const [editItem, setEditItem] = useState<Category | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [catName, setCatName] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => setPage(1), [search]);

  const { data, isLoading } = useQuery<CategoryList>({
    queryKey: ['categories', search, page],
    queryFn: () => api.get<CategoryList>(`/categories?q=${encodeURIComponent(search)}&page=${page}&pageSize=25`),
    placeholderData: prev => prev,
  });
  const { data: allCatsData } = useQuery<CategoryList>({ queryKey: ['categories', ''], queryFn: () => api.get<CategoryList>('/categories?pageSize=200'), staleTime: 60_000 });
  const allCats = allCatsData?.items ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['categories'] });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/categories/${id}`),
    onSuccess: () => { invalidate(); showToast('Category deleted', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  async function save() {
    if (!catName.trim()) { setFormError('Name is required'); return; }
    setSaving(true);
    try {
      if (editItem) await api.put(`/categories/${editItem.id}`, { name: catName.trim(), parentId });
      else await api.post('/categories', { name: catName.trim(), parentId });
      invalidate(); showToast(editItem ? 'Updated' : 'Created', 'success'); setShowForm(false);
    } catch (e: unknown) { setFormError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <SimpleListTab title="Categories" icon="🏷️" total={data?.total} searchRaw={searchRaw} onSearch={setSearchRaw}
      canWrite={canWrite(userRole, userPermissions)} onAdd={() => { setEditItem(null); setCatName(''); setParentId(null); setFormError(''); setShowForm(true); }}
      isLoading={isLoading} page={page} totalPages={Math.ceil((data?.total ?? 0) / 25)} onPage={setPage}
      columns={['Name', 'Parent', 'Books', 'Added', '']}
      rows={(data?.items ?? []).map(c => [
        <span key="n" className="font-medium text-gray-900 dark:text-white text-sm">{c.name}</span>,
        <span key="p" className="text-gray-500 text-xs">{c.parentName ?? '—'}</span>,
        <span key="b" className="text-gray-500 text-sm">{c.bookCount ?? 0}</span>,
        <span key="d" className="text-gray-400 text-xs">{fmtDate(c.createdAt)}</span>,
        canWrite(userRole, userPermissions) ? (
          <div key="a" className="flex gap-3 justify-end">
            <button onClick={() => { setEditItem(c); setCatName(c.name); setParentId(c.parentId); setFormError(''); setShowForm(true); }} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
            <button onClick={() => { if (confirm(`Delete "${c.name}"?`)) deleteMut.mutate(c.id); }} className="text-xs text-red-500 hover:underline">Delete</button>
          </div>
        ) : null,
      ])}>
      {showForm && (
        <Drawer title={editItem ? 'Edit Category' : 'New Category'} onClose={() => setShowForm(false)}
          footer={<><Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn><Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
            <FField label="Category Name *" value={catName} onChange={setCatName} placeholder="e.g. Science Fiction" />
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Parent Category (optional)</label>
              <select value={parentId ?? ''} onChange={e => setParentId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— Top level —</option>
                {allCats.filter(c => c.id !== editItem?.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
        </Drawer>
      )}
    </SimpleListTab>
  );
}

// ── PublishersTab ─────────────────────────────────────────────────────────────
function PublishersTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounce(searchRaw, 300);
  const [page, setPage] = useState(1);
  const [editItem, setEditItem] = useState<Publisher | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [pubName, setPubName] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => setPage(1), [search]);

  const { data, isLoading } = useQuery<PublisherList>({
    queryKey: ['publishers', search, page],
    queryFn: () => api.get<PublisherList>(`/publishers?q=${encodeURIComponent(search)}&page=${page}&pageSize=25`),
    placeholderData: prev => prev,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['publishers'] });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/publishers/${id}`),
    onSuccess: () => { invalidate(); showToast('Publisher deleted', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  async function save() {
    if (!pubName.trim()) { setFormError('Name is required'); return; }
    setSaving(true);
    try {
      if (editItem) await api.put(`/publishers/${editItem.id}`, { name: pubName.trim() });
      else await api.post('/publishers', { name: pubName.trim() });
      invalidate(); showToast(editItem ? 'Updated' : 'Created', 'success'); setShowForm(false);
    } catch (e: unknown) { setFormError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <SimpleListTab title="Publishers" icon="🏢" total={data?.total} searchRaw={searchRaw} onSearch={setSearchRaw}
      canWrite={canWrite(userRole, userPermissions)} onAdd={() => { setEditItem(null); setPubName(''); setFormError(''); setShowForm(true); }}
      isLoading={isLoading} page={page} totalPages={Math.ceil((data?.total ?? 0) / 25)} onPage={setPage}
      columns={['Name', 'Books', 'Added', '']}
      rows={(data?.items ?? []).map(p => [
        <span key="n" className="font-medium text-gray-900 dark:text-white text-sm">{p.name}</span>,
        <span key="b" className="text-gray-500 text-sm">{p.bookCount ?? 0}</span>,
        <span key="d" className="text-gray-400 text-xs">{fmtDate(p.createdAt)}</span>,
        canWrite(userRole, userPermissions) ? (
          <div key="a" className="flex gap-3 justify-end">
            <button onClick={() => { setEditItem(p); setPubName(p.name); setFormError(''); setShowForm(true); }} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
            <button onClick={() => { if (confirm(`Delete "${p.name}"?`)) deleteMut.mutate(p.id); }} className="text-xs text-red-500 hover:underline">Delete</button>
          </div>
        ) : null,
      ])}>
      {showForm && (
        <Drawer title={editItem ? 'Edit Publisher' : 'New Publisher'} onClose={() => setShowForm(false)}
          footer={<><Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn><Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
            <FField label="Publisher Name *" value={pubName} onChange={setPubName} placeholder="e.g. Penguin Books" />
          </div>
        </Drawer>
      )}
    </SimpleListTab>
  );
}


// ── Shared UI components ──────────────────────────────────────────────────────

function SimpleListTab({ title, icon, total, searchRaw, onSearch, canWrite, onAdd, isLoading, columns, rows, page, totalPages, onPage, children }: {
  title: string; icon: string; total?: number; searchRaw: string; onSearch: (v: string) => void;
  canWrite: boolean; onAdd: () => void; isLoading: boolean;
  columns: string[]; rows: (React.ReactNode | null)[][];
  page: number; totalPages: number; onPage: (p: number) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <span className="text-lg">{icon}</span>
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
          {total !== undefined && <p className="text-xs text-gray-400">{total} {title.toLowerCase()}</p>}
        </div>
        <div className="flex-1 max-w-xs">
          <input value={searchRaw} onChange={e => onSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}…`}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex-1" />
        {canWrite && (
          <button onClick={onAdd} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            + Add {title.slice(0, -1)}
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
             rows.length === 0 ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">No {title.toLowerCase()} found</td></tr>
            ) : rows.map((cells, i) => (
              <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                {cells.map((cell, j) => (
                  <td key={j} className={`px-4 py-3 ${j === cells.length - 1 ? 'text-right' : ''}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-6 py-2.5 flex items-center justify-between flex-shrink-0">
        <span className="text-xs text-gray-500">{total ?? 0} total</span>
        <div className="flex items-center gap-1">
          <PagBtn onClick={() => onPage(1)} disabled={page === 1} label="«" />
          <PagBtn onClick={() => onPage(Math.max(1, page - 1))} disabled={page === 1} label="‹" />
          <span className="px-3 py-1 text-xs bg-blue-600 text-white rounded font-medium">{page}</span>
          <PagBtn onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} label="›" />
          <PagBtn onClick={() => onPage(totalPages)} disabled={page === totalPages} label="»" />
        </div>
      </div>
      {children}
    </div>
  );
}

function Drawer({ title, onClose, footer, tabs, activeTab, onTabChange, children }: {
  title: string; onClose: () => void; footer?: React.ReactNode;
  tabs?: { id: string; label: string }[]; activeTab?: string; onTabChange?: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-[480px] bg-white dark:bg-gray-900 shadow-2xl flex flex-col h-full border-l border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">✕</button>
        </div>
        {tabs && tabs.length > 0 && (
          <div className="flex border-b border-gray-200 dark:border-gray-800 px-5 gap-1 flex-shrink-0">
            {tabs.map(t => (
              <button key={t.id} onClick={() => onTabChange?.(t.id)}
                className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800 flex gap-3 flex-shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

function MasterSelect({ items, selected, onChange, placeholder }: {
  items: { id: number; label: string; sub?: string }[];
  selected: number[]; onChange: (ids: number[]) => void; placeholder: string;
}) {
  const [q, setQ] = useState('');
  const filtered = items.filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none" />
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 ? <p className="px-3 py-3 text-xs text-gray-400 italic">No results</p> :
          filtered.map(item => (
            <label key={item.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
              <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} className="rounded border-gray-300 dark:border-gray-600 text-blue-600" />
              <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{item.label}</span>
              {item.sub && <span className="text-xs text-gray-400">{item.sub}</span>}
            </label>
          ))}
      </div>
      {selected.length > 0 && (
        <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-1">
          {selected.map(id => {
            const item = items.find(i => i.id === id);
            return item ? (
              <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs rounded-full">
                {item.label} <button type="button" onClick={() => toggle(id)} className="hover:text-red-500 leading-none">✕</button>
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

function SortTh({ label, col, sortBy, sortDir, onSort, align = 'left' }: {
  label: string; col: string; sortBy: string; sortDir: 'asc' | 'desc'; onSort: (c: string) => void; align?: 'left' | 'right';
}) {
  const active = sortBy === col;
  return (
    <th className={`px-4 py-3 text-${align}`}>
      <button onClick={() => onSort(col)}
        className={`flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors ${align === 'right' ? 'ml-auto' : ''} ${active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
        {label} <span className="text-xs">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );
}

function PagBtn({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-2.5 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300">
      {label}
    </button>
  );
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse">
      {[...Array(cols)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded" style={{ width: `${50 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

function DRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 dark:text-gray-400 w-28 flex-shrink-0 text-xs">{label}</span>
      <span className={`text-gray-800 dark:text-gray-200 text-xs ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function FField({ label, value, onChange, placeholder, type = 'text', disabled }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        step={type === 'number' ? '0.01' : undefined} min={type === 'number' ? '0' : undefined}
        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}

function Btn({ children, onClick, disabled, variant = 'primary' }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: 'primary' | 'secondary';
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${variant === 'primary' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>
      {children}
    </button>
  );
}

function RowMenu({ items }: { items: { label: string; icon: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function handleOpen() {
    if (!open && btnRef.current) {
      // Detect if there's enough space below; if not, open upward
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUp(spaceBelow < 160); // 160px ≈ 4 menu items
    }
    setOpen(o => !o);
  }

  return (
    <div className="relative" ref={ref}>
      <button ref={btnRef} onClick={handleOpen}
        className="px-2 py-1 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors opacity-40 group-hover:opacity-100"
        title="Actions">
        ⋯
      </button>
      {open && (
        <div className={`absolute right-0 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-30 py-1 ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {items.map((item, i) => (
            <button key={i} onClick={() => { item.onClick(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${item.danger ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
              <span className="text-base leading-none">{item.icon}</span>{item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
