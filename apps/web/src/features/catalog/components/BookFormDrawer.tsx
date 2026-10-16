// The book form, moved unchanged from pages/CatalogPage.tsx; PR 3 of the
// catalog step (#23) rebuilds it on the shared contract with search pickers (#95).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Book } from '@bms/shared';
import { isValidIsbn } from '../../../lib/isbn.js';
import { api } from '../../../lib/api.js';
import { Drawer } from '../../../shared/components/Drawer.js';

interface Author { id: number; name: string; bookCount?: number; }
interface AuthorList { items: Author[]; total: number; }
interface Category { id: number; name: string; parentName?: string | null; }
interface CategoryList { items: Category[]; total: number; }
interface Publisher { id: number; name: string; }
interface PublisherList { items: Publisher[]; total: number; }
interface BookFormat { id: number; code: string; label: string; sortOrder: number; }
interface BookEdition { id: number; code: string; label: string; sortOrder: number; }

export function BookFormDrawer({ book, currency, onClose, onSaved, showToast }: {
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
      if (!isValidIsbn(rawIsbn)) { setError('Enter a valid ISBN-13 or ISBN-10'); return; }
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
                <FField label="ISBN-13 or ISBN-10 (optional)" value={isbn} onChange={setIsbn} placeholder="9780306406157" disabled={!!book} />
                {!book && <p className="text-xs text-gray-400 mt-1">Leave blank to use SKU</p>}
              </div>
              <FField label="SKU / Internal ID" value={sku} onChange={setSku} placeholder="BK-001" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Publisher</label>
              <select value={publisherId ?? ''} onChange={e => setPublisherId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
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
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${!formatId ? 'border-amber-400 dark:border-amber-600' : 'border-gray-300 dark:border-gray-600'}`}>
                <option value="">— Select format —</option>
                {allFormats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              {!formatId && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Required</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Edition *</label>
              <select value={editionId ?? ''} onChange={e => setEditionId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${!editionId ? 'border-amber-400 dark:border-amber-600' : 'border-gray-300 dark:border-gray-600'}`}>
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
        className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden" />
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 ? <p className="px-3 py-3 text-xs text-gray-400 italic">No results</p> :
          filtered.map(item => (
            <label key={item.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
              <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} className="rounded-sm border-gray-300 dark:border-gray-600 text-blue-600" />
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

function FField({ label, value, onChange, placeholder, type = 'text', disabled }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        step={type === 'number' ? '0.01' : undefined} min={type === 'number' ? '0' : undefined}
        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
