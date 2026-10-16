import { useState } from 'react';
import type { StockLevel } from '@bms/shared';
import { useMyProfile } from '../../account/queries.js';
import { findStockLevel } from '../api.js';
import { canUseLocation } from '../rules.js';

export const INPUT = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
export const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

/** A whole number of copies, more than zero, as typed. */
export const isPositiveWhole = (v: string) => /^\d+$/.test(v) && Number(v) > 0;

/**
 * The book and location a stock change is for, and what the last change
 * said. A row from the Stock Levels quick buttons is chosen only when the
 * staff member may use its location.
 */
export function useStockChange(initialRow: StockLevel | null) {
  const { data: me } = useMyProfile();
  const [chosen, setChosen] = useState<StockLevel | null>(
    initialRow && canUseLocation(me, initialRow.locationId) ? initialRow : null,
  );
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function choose(row: StockLevel) {
    setChosen(row);
    setError('');
    setSuccess('');
  }

  /** Shows why the API refused; after a conflict the chosen row is read again (was: kept stale, so every retry failed). */
  async function refused(err: unknown) {
    const e = err as { message?: string; code?: string };
    if (e.code !== 'VERSION_CONFLICT' || !chosen) {
      setError(e.message ?? 'Unknown error');
      return;
    }
    setError('Inventory was updated by someone else. Refreshing…');
    const fresh = await findStockLevel(chosen.bookId, chosen.locationId).catch(() => null);
    if (fresh) setChosen(fresh);
  }

  return { chosen, setChosen, choose, error, setError, success, setSuccess, refused };
}

export function Messages({ error, success }: { error: string; success: string }) {
  return (
    <>
      {error && <div role="alert" className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}
      {success && <div role="status" className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm text-emerald-700 dark:text-emerald-300">{success}</div>}
    </>
  );
}
