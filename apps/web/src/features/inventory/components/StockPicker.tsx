import { useState } from 'react';
import type { StockLevel } from '@bms/shared';
import { useMyProfile } from '../../account/queries.js';
import { useStockSearch } from '../queries.js';
import { canUseLocation } from '../rules.js';
import { useDebounce } from './shared.js';

const CHOSEN = { emerald: 'bg-emerald-50 dark:bg-emerald-950/30', blue: 'bg-blue-50 dark:bg-blue-950/30' };

/**
 * The left panel of the stock change tabs: search the session branch's stock
 * and choose a book at one location. Only the locations the staff member may
 * use are listed (was: every location, which the API then refused).
 */
export function StockPicker({ chosen, onChoose, accent = 'blue', markLow = false }: {
  chosen: StockLevel | null;
  onChoose: (row: StockLevel) => void;
  accent?: keyof typeof CHOSEN;
  /** Marks rows at or below their reorder point. */
  markLow?: boolean;
}) {
  const { data: me } = useMyProfile();
  const [qRaw, setQRaw] = useState('');
  // Asks once typing pauses (was: on every key).
  const q = useDebounce(qRaw.trim(), 300);
  const { data } = useStockSearch(q);
  const rows = (data?.items ?? []).filter((row) => canUseLocation(me, row.locationId));

  return (
    <div className="w-80 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-800">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
        <input value={qRaw} onChange={e => setQRaw(e.target.value)} placeholder="Search books…" aria-label="Search books"
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.map(row => (
          <button key={`${row.bookId}-${row.locationId}`} type="button" onClick={() => onChoose(row)}
            aria-pressed={chosen?.bookId === row.bookId && chosen.locationId === row.locationId}
            className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${chosen?.bookId === row.bookId && chosen.locationId === row.locationId ? CHOSEN[accent] : ''}`}>
            <div className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{row.bookTitle}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {row.locationName} · Qty: <span className={row.isLowStock ? 'text-amber-600 font-semibold' : 'font-semibold'}>{row.quantity}</span>
              {markLow && row.isLowStock && <span className="ml-1 text-amber-500">⚠</span>}
            </div>
          </button>
        ))}
        {q.length > 1 && data && !rows.length && <p className="px-4 py-3 text-xs text-gray-400 italic">No results</p>}
        {qRaw.trim().length <= 1 && <p className="px-4 py-3 text-xs text-gray-400 italic">Type to search books…</p>}
      </div>
    </div>
  );
}
