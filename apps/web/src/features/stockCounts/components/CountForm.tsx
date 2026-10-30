import { useState } from 'react';
import type { StockCountScope } from '@bms/shared';
import { getCurrentBranchId } from '../../../lib/api.js';
import { useMyProfile } from '../../account/queries.js';
import { INPUT, LABEL, Messages } from '../../inventory/components/stockChange.js';
import { canUseLocation } from '../../inventory/rules.js';
import { useLocations } from '../../locations/queries.js';
import { useOpenStockCount } from '../queries.js';
import { BookFinder } from './BookFinder.js';

/** A new count (#172, decisions 1a, 4a): a location one may use, every book there or books chosen by searching there. */
export function CountForm({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const { data: me } = useMyProfile();
  const { data: locationList } = useLocations(getCurrentBranchId());
  const locations = (locationList?.items ?? []).filter((l) => canUseLocation(me, l.id));
  const [chosen, setLocation] = useState<number | null>(null);
  const locationId = chosen ?? locations.find((l) => l.isDefaultFulfillment)?.id ?? locations[0]?.id ?? null;
  const [scope, setScope] = useState<StockCountScope>('full');
  const [books, setBooks] = useState<Array<{ bookId: number; title: string }>>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const open = useOpenStockCount();
  const ready = locationId !== null && (scope === 'full' || books.length > 0);

  function submit() {
    if (locationId === null) return;
    setError('');
    open.mutate(
      { locationId, scope, ...(scope === 'selected' && { bookIds: books.map((b) => b.bookId) }), notes: notes.trim() || null },
      { onSuccess: (c) => onDone(c.id), onError: (e) => setError((e as Error).message) },
    );
  }

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-2xl mx-auto space-y-4">
        <button type="button" onClick={onCancel} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">New count</h2>
        <Messages error={error} success="" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="count-location" className={LABEL}>Location</label>
            <select id="count-location" className={INPUT} value={locationId ?? ''} onChange={(e) => { setLocation(Number(e.target.value)); setBooks([]); }}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="count-scope" className={LABEL}>What to count</label>
            <select id="count-scope" className={INPUT} value={scope} onChange={(e) => setScope(e.target.value as StockCountScope)}>
              <option value="full">Every book at the location</option>
              <option value="selected">Chosen books</option>
            </select>
          </div>
        </div>
        {scope === 'selected' && (
          <>
            <BookFinder locationId={locationId} exclude={books.map((b) => b.bookId)} onAdd={(b) => setBooks((bs) => [...bs, { bookId: b.bookId, title: b.title }])} />
            <ul className="text-sm space-y-1">
              {books.map((b) => (
                <li key={b.bookId} className="flex justify-between">
                  <span>{b.title}</span>
                  <button type="button" aria-label={`Remove ${b.title}`} onClick={() => setBooks((bs) => bs.filter((x) => x.bookId !== b.bookId))} className="text-gray-400 hover:text-red-500">✕</button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div>
          <label htmlFor="count-notes" className={LABEL}>Notes</label>
          <textarea id="count-notes" rows={2} maxLength={2000} className={INPUT} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">What each book holds is frozen now; selling goes on while you count.</p>
        <div className="flex justify-end">
          <button type="button" disabled={!ready || open.isPending} onClick={submit}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">Open count</button>
        </div>
      </div>
    </div>
  );
}
