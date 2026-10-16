import { useState } from 'react';
import { Controller, useForm, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money, type Book, type CreateBookRequest, type UpdateBookRequest } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { isValidIsbn } from '../../../lib/isbn.js';
import { Drawer } from '../../../shared/components/Drawer.js';
import { SearchPicker } from '../../../shared/components/SearchPicker.js';
import { MultiSearchPicker } from '../../../shared/components/MultiSearchPicker.js';
import { searchAuthors, searchCategories, searchPublishers } from '../../catalogReference/api.js';
import { useBookEditions, useBookFormats } from '../../catalogReference/queries.js';
import { useSaveBook } from '../queries.js';

const Picked = z.object({ id: z.number().int(), label: z.string() });
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const amount = z.string().trim().refine((v) => v === '' || AMOUNT.test(v), 'Enter an amount such as 12.50');
const text = (max: number) => z.string().trim().max(max, `At most ${max} characters`);
const lookupId = (message: string) => z.number({ error: message }).int().positive(message);

/**
 * The form's fields, checked with the limits of the API's book contract. A
 * book's ISBN is set once; a price, once set, can be changed but not removed
 * (the API keeps it).
 */
function bookFormSchema(book: Book | null) {
  return z.object({
    title: z.string().trim().min(1, 'Title is required').max(500, 'At most 500 characters'),
    isbn: z.string().trim().refine((v) => book !== null || v === '' || isValidIsbn(v), 'Enter a valid ISBN-13 or ISBN-10'),
    sku: text(100),
    publisher: Picked.nullable(),
    genre: text(100),
    language: text(50),
    description: z.string().max(5000, 'At most 5000 characters'),
    formatId: lookupId('Book format is required'),
    editionId: lookupId('Edition is required'),
    authors: z.array(Picked).min(1, 'At least one author is required'),
    categories: z.array(Picked),
    tags: z.string(),
    defaultPrice: amount.refine((v) => v !== '' || book?.defaultPrice == null, 'A price cannot be removed; enter 0 for none'),
    tradeValue: amount.refine((v) => v !== '' || book?.tradeValue == null, 'A trade value cannot be removed; enter 0 for none'),
  });
}
type BookFormValues = z.infer<ReturnType<typeof bookFormSchema>>;
type Section = 'basic' | 'physical' | 'authors' | 'categories' | 'pricing';

/** The tab each field is on, to open the tab of the first field to correct. */
const SECTION_OF: Record<keyof BookFormValues, Section> = {
  title: 'basic', isbn: 'basic', sku: 'basic', publisher: 'basic', genre: 'basic', language: 'basic', description: 'basic',
  formatId: 'physical', editionId: 'physical', authors: 'authors', categories: 'categories', tags: 'categories',
  defaultPrice: 'pricing', tradeValue: 'pricing',
};
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'basic', label: 'Basic Info' }, { id: 'physical', label: 'Physical' }, { id: 'authors', label: 'Authors' },
  { id: 'categories', label: 'Categories' }, { id: 'pricing', label: 'Pricing' },
];

const shownIsbn = (isbn: string) => (isbn.startsWith('SKU-') || isbn.startsWith('AUTO-') ? '' : isbn);
/** A book's linked names and ids come in the same order. */
const picked = (names: string[], ids: number[]) => ids.map((id, i) => ({ id, label: names[i] ?? String(id) }));
const money = (v: string) => (v === '' ? undefined : Money.of(v).toNumber());

function defaults(book: Book | null): BookFormValues {
  return {
    title: book?.title ?? '', isbn: book ? shownIsbn(book.isbn) : '', sku: book?.sku ?? '',
    publisher: book?.publisherId ? { id: book.publisherId, label: book.publisher ?? '' } : null,
    genre: book?.genre ?? '', language: book?.language ?? '', description: book?.description ?? '',
    // Unset until chosen; the schema asks for them.
    formatId: book?.formatId ?? (undefined as unknown as number), editionId: book?.editionId ?? (undefined as unknown as number),
    authors: book ? picked(book.authors, book.authorIds) : [], categories: book ? picked(book.categories, book.categoryIds) : [],
    tags: book?.tags.join(', ') ?? '',
    defaultPrice: book?.defaultPrice != null ? String(book.defaultPrice) : '',
    tradeValue: book?.tradeValue != null ? String(book.tradeValue) : '',
  };
}

/**
 * What to send. On a change every field is sent, so one emptied is cleared
 * (was: left out, so it kept its old value).
 */
function requestOf(v: BookFormValues, book: Book | null): CreateBookRequest | UpdateBookRequest {
  const common = {
    title: v.title, authorIds: v.authors.map((a) => a.id), categoryIds: v.categories.map((c) => c.id),
    formatId: v.formatId, editionId: v.editionId,
    tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean),
    defaultPrice: money(v.defaultPrice), tradeValue: money(v.tradeValue),
  };
  if (book) {
    return { ...common, sku: v.sku, publisherId: v.publisher?.id ?? null, genre: v.genre, language: v.language, description: v.description };
  }
  return {
    ...common, isbn: v.isbn.replace(/[-\s]/g, '') || undefined, sku: v.sku || undefined, publisherId: v.publisher?.id ?? null,
    genre: v.genre || undefined, language: v.language || undefined, description: v.description || undefined,
  };
}

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const BUTTON = 'flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';

/** Adds a book, or edits one. */
export function BookFormDrawer({ book, currency, onClose, onSaved }: {
  book: Book | null; currency: string; onClose: () => void; onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [section, setSection] = useState<Section>('basic');
  const [problem, setProblem] = useState('');
  const save = useSaveBook();
  const formats = useBookFormats().data?.items ?? [];
  const editions = useBookEditions().data?.items ?? [];

  const { register, control, handleSubmit, watch, formState: { errors } } = useForm<BookFormValues>({
    resolver: zodResolver(bookFormSchema(book)),
    defaultValues: defaults(book),
  });
  const formatId = watch('formatId');
  const editionId = watch('editionId');

  const onValid = (v: BookFormValues) => {
    setProblem('');
    const request = book ? { id: book.id, body: requestOf(v, book) } : { id: null, body: requestOf(v, null) as CreateBookRequest };
    save.mutate(request, {
      onSuccess: () => { showToast(book ? 'Book updated' : 'Book created', 'success'); onSaved(); },
      onError: (e: Error) => setProblem(e.message),
    });
  };
  // Opens the tab of the first field to correct, and says what is wrong.
  const onInvalid = (errs: FieldErrors<BookFormValues>) => {
    const first = (Object.keys(SECTION_OF) as Array<keyof BookFormValues>).find((k) => errs[k]);
    if (!first) return;
    setSection(SECTION_OF[first]);
    setProblem(errs[first]?.message ?? 'Check this field');
  };
  const submit = handleSubmit(onValid, onInvalid);
  const invalid = (name: keyof BookFormValues) => (errors[name] ? true : undefined);
  const lookupValue = { setValueAs: (v: string) => (v === '' ? undefined : Number(v)) };

  return (
    <Drawer title={book ? 'Edit Book' : 'Add Book'} onClose={onClose}
      tabs={SECTIONS} activeTab={section} onTabChange={(id) => setSection(id as Section)}
      footer={<>
        <button type="button" onClick={onClose} className={`${BUTTON} border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300`}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={save.isPending} className={`${BUTTON} bg-blue-600 hover:bg-blue-700 text-white`}>{save.isPending ? 'Saving…' : book ? 'Save' : 'Create'}</button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        {problem && (
          <div role="alert" className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300 flex gap-2">
            <span>⚠️</span><span>{problem}</span>
          </div>
        )}

        {section === 'basic' && (
          <>
            <div>
              <label htmlFor="book-title" className={LABEL}>Title *</label>
              <input id="book-title" {...register('title')} aria-invalid={invalid('title')} className={INPUT} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="book-isbn" className={LABEL}>ISBN-13 or ISBN-10 (optional)</label>
                <input id="book-isbn" {...register('isbn')} placeholder="9780306406157" disabled={!!book} aria-invalid={invalid('isbn')} className={INPUT} />
                {!book && <p className="text-xs text-gray-400 mt-1">Leave blank to use SKU</p>}
              </div>
              <div>
                <label htmlFor="book-sku" className={LABEL}>SKU / Internal ID</label>
                <input id="book-sku" {...register('sku')} placeholder="BK-001" aria-invalid={invalid('sku')} className={INPUT} />
              </div>
            </div>
            <div>
              <label className={LABEL}>Publisher</label>
              <Controller control={control} name="publisher" render={({ field }) => (
                <SearchPicker aria-label="Publisher" value={field.value} onChange={field.onChange} queryKey="publishers"
                  search={async (q) => (await searchPublishers(q)).items.map((p) => ({ id: p.id, label: p.name }))}
                  placeholder="No publisher — type to search…" className={INPUT} />
              )} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="book-genre" className={LABEL}>Genre</label>
                <input id="book-genre" {...register('genre')} aria-invalid={invalid('genre')} className={INPUT} />
              </div>
              <div>
                <label htmlFor="book-language" className={LABEL}>Language</label>
                <input id="book-language" {...register('language')} aria-invalid={invalid('language')} className={INPUT} />
              </div>
            </div>
            <div>
              <label htmlFor="book-description" className={LABEL}>Description</label>
              <textarea id="book-description" {...register('description')} rows={3} aria-invalid={invalid('description')}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
            </div>
          </>
        )}

        {section === 'physical' && (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">Format and Edition are required.</p>
            <div>
              <label htmlFor="book-format" className={LABEL}>Book Format *</label>
              <select id="book-format" {...register('formatId', lookupValue)} aria-invalid={invalid('formatId')}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${!formatId ? 'border-amber-400 dark:border-amber-600' : 'border-gray-300 dark:border-gray-600'}`}>
                <option value="">— Select format —</option>
                {formats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              {!formatId && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Required</p>}
            </div>
            <div>
              <label htmlFor="book-edition" className={LABEL}>Edition *</label>
              <select id="book-edition" {...register('editionId', lookupValue)} aria-invalid={invalid('editionId')}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${!editionId ? 'border-amber-400 dark:border-amber-600' : 'border-gray-300 dark:border-gray-600'}`}>
                <option value="">— Select edition —</option>
                {editions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              {!editionId && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Required</p>}
            </div>
            {formatId && editionId && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300">
                {formats.find((f) => f.id === formatId)?.label} · {editions.find((e) => e.id === editionId)?.label}
              </div>
            )}
          </>
        )}

        {section === 'authors' && (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">Select from master list. Add new authors in the Authors tab.</p>
            <Controller control={control} name="authors" render={({ field }) => (
              <MultiSearchPicker aria-label="Authors" value={field.value} onChange={field.onChange} queryKey="authors" invalid={!!errors.authors}
                search={async (q) => (await searchAuthors(q)).items.map((a) => ({ id: a.id, label: a.name }))}
                placeholder="Search authors…" className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg focus:outline-hidden" />
            )} />
          </>
        )}

        {section === 'categories' && (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">Select from master list. Add new categories in the Categories tab.</p>
            <Controller control={control} name="categories" render={({ field }) => (
              <MultiSearchPicker aria-label="Categories" value={field.value} onChange={field.onChange} queryKey="categories"
                search={async (q) => (await searchCategories(q)).items.map((c) => ({ id: c.id, label: c.name }))}
                placeholder="Search categories…" className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg focus:outline-hidden" />
            )} />
            <div>
              <label htmlFor="book-tags" className={LABEL}>Tags (comma-separated)</label>
              <input id="book-tags" {...register('tags')} placeholder="bestseller, award-winner…" className={INPUT} />
            </div>
          </>
        )}

        {section === 'pricing' && (
          <>
            <div>
              <label htmlFor="book-price" className={LABEL}>Default Price ({currency})</label>
              <input id="book-price" type="number" step="0.01" min="0" {...register('defaultPrice')} aria-invalid={invalid('defaultPrice')} className={INPUT} />
            </div>
            <div>
              <label htmlFor="book-trade-value" className={LABEL}>Trade Value ({currency})</label>
              <input id="book-trade-value" type="number" step="0.01" min="0" {...register('tradeValue')} aria-invalid={invalid('tradeValue')} className={INPUT} />
            </div>
          </>
        )}
      </form>
    </Drawer>
  );
}
