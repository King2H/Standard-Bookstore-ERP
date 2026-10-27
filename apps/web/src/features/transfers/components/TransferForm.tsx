import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Transfer, TransferRequest } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import { getCurrentBranchId } from '../../../lib/api.js';
import { useMyProfile } from '../../account/queries.js';
import { useOpenBranches } from '../../branches/queries.js';
import { findStockLevel, listStockLevels } from '../../inventory/api.js';
import { INPUT, LABEL, Messages, isPositiveWhole } from '../../inventory/components/stockChange.js';
import { inventoryKeys } from '../../inventory/queries.js';
import { canUseLocation } from '../../inventory/rules.js';
import { useLocations } from '../../locations/queries.js';
import { useCreateTransfer, useDispatchTransfer, useUpdateTransfer } from '../queries.js';

type Line = { bookId: number; title: string; quantity: string; onHand: number | null };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * A transfer note being drafted (#170, decision 2a): from a location of the
 * session's branch the staff member may use (#72) to another open branch,
 * with books found at that location and never more than it holds. Saved as a
 * draft, or dispatched after a confirmation.
 */
export function TransferForm({ draft, onDone, onCancel }: { draft: Transfer | null; onDone: (id: number) => void; onCancel: () => void }) {
  const { data: me } = useMyProfile();
  const branchId = getCurrentBranchId();
  const { data: locationList } = useLocations(branchId);
  const { data: branchList } = useOpenBranches();
  const locations = (locationList?.items ?? []).filter((l) => canUseLocation(me, l.id));
  const destinations = (branchList?.items ?? []).filter((b) => b.id !== branchId);

  const [chosenFrom, setFrom] = useState<number | null>(draft?.fromLocationId ?? null);
  // Until one is chosen, the branch's default location, else its first.
  const fromLocationId = chosenFrom ?? locations.find((l) => l.isDefaultFulfillment)?.id ?? locations[0]?.id ?? null;
  const [toBranchId, setTo] = useState<string>(draft ? String(draft.toBranchId) : '');
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [lines, setLines] = useState<Line[]>(
    () => draft?.lines.map((l) => ({ bookId: l.bookId, title: l.bookTitle, quantity: String(l.quantity), onHand: null })) ?? [],
  );
  const [term, setTerm] = useState('');
  const typed = useDebounced(term.trim(), 250);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const create = useCreateTransfer();
  const update = useUpdateTransfer();
  const dispatch = useDispatchTransfer();
  const busy = create.isPending || update.isPending || dispatch.isPending;

  const search = useQuery({
    queryKey: inventoryKeys.levels({ q: typed, locationId: fromLocationId ?? undefined, pageSize: 10 }),
    queryFn: () => listStockLevels({ q: typed, locationId: fromLocationId ?? undefined, pageSize: 10 }),
    enabled: typed.length > 1 && fromLocationId !== null,
  });
  // What the source holds of a book added before (a draft being edited, or a source changed since).
  const lookups = useQueries({
    queries: lines.map((l) => ({
      queryKey: [...inventoryKeys.all, 'at', l.bookId, fromLocationId] as const,
      queryFn: () => findStockLevel(l.bookId, fromLocationId!),
      enabled: l.onHand === null && fromLocationId !== null,
    })),
  });
  const onHandOf = (i: number) => lines[i].onHand ?? lookups[i]?.data?.quantity ?? null;

  function chooseFrom(id: number) {
    setFrom(id);
    // The copies on hand are the new source's.
    setLines((ls) => ls.map((l) => ({ ...l, onHand: null })));
  }

  const results = (search.data?.items ?? []).filter((r) => !lines.some((l) => l.bookId === r.bookId));
  const problems = lines.map((l, i) => {
    if (!isPositiveWhole(l.quantity.trim())) return 'Enter a whole number of copies';
    const onHand = onHandOf(i);
    return onHand !== null && Number(l.quantity) > onHand ? `Only ${Math.max(0, onHand)} on hand` : '';
  });
  const ready = fromLocationId !== null && toBranchId !== '' && lines.length > 0 && problems.every((p) => !p);
  const fromName = locations.find((l) => l.id === fromLocationId)?.name ?? '';
  const toName = destinations.find((b) => String(b.id) === toBranchId)?.name ?? '';

  const body = useMemo((): TransferRequest | null => fromLocationId === null ? null : {
    fromLocationId,
    toBranchId: Number(toBranchId),
    lines: lines.map((l) => ({ bookId: l.bookId, quantity: Number(l.quantity) })),
    notes: notes.trim() || null,
  }, [fromLocationId, toBranchId, lines, notes]);

  async function save(): Promise<number | null> {
    if (!body) return null;
    setError('');
    try {
      const saved = draft ? await update.mutateAsync({ id: draft.id, body }) : await create.mutateAsync(body);
      return saved.id;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }

  async function saveDraft() {
    const id = await save();
    if (id !== null) onDone(id);
  }

  async function saveAndDispatch() {
    const id = await save();
    if (id === null) { setConfirming(false); return; }
    try {
      await dispatch.mutateAsync(id);
      onDone(id);
    } catch (err) {
      // The note stays a draft; the reason shows on it.
      setError((err as Error).message);
      setConfirming(false);
      onDone(id);
    }
  }

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-3xl mx-auto space-y-5">
        <div>
          <button type="button" onClick={onCancel} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>
          <h2 className="mt-2 text-base font-semibold text-gray-900 dark:text-white">{draft ? `Edit ${draft.transferNumber}` : 'New transfer'}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Books leave at their average cost and are in transit until the other branch receives them.</p>
        </div>

        <Messages error={error} success="" />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="transfer-from" className={LABEL}>From location</label>
            <select id="transfer-from" className={INPUT} value={fromLocationId ?? ''} onChange={(e) => chooseFrom(Number(e.target.value))}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="transfer-to-branch" className={LABEL}>To branch</label>
            <select id="transfer-to-branch" className={INPUT} value={toBranchId} onChange={(e) => setTo(e.target.value)}>
              <option value="">— Select branch —</option>
              {destinations.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="transfer-find" className={LABEL}>Find a book</label>
          <input id="transfer-find" type="text" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Title or ISBN at the source location"
            className={INPUT} disabled={fromLocationId === null} />
          {/* Hidden as soon as the box is cleared, not after the search catches up. */}
          {term.trim().length > 1 && typed.length > 1 && (
            <ul className="mt-1 border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
              {results.length === 0 && !search.isFetching && (
                <li className="px-3 py-2 text-xs text-gray-400">
                  {search.data?.items.length ? 'Already on this transfer.' : 'No book found at this location.'}
                </li>
              )}
              {results.map((r) => (
                <li key={r.bookId}>
                  <button type="button" disabled={r.quantity <= 0}
                    onClick={() => { setLines((ls) => [...ls, { bookId: r.bookId, title: r.bookTitle, quantity: '1', onHand: r.quantity }]); setTerm(''); }}
                    className="w-full flex justify-between px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">
                    <span>Add {r.bookTitle}</span>
                    <span className="text-xs text-gray-500"> · {Math.max(0, r.quantity)} on hand</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
              <tr><th className="px-4 py-2 text-left">Book</th><th className="px-4 py-2 text-right">On hand</th><th className="px-4 py-2 text-right w-32">Copies</th><th className="w-10" /></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {lines.length === 0 && <tr><td colSpan={4} className="px-4 py-4 text-center text-gray-400">Find a book to add it.</td></tr>}
              {lines.map((l, i) => (
                <tr key={l.bookId}>
                  <td className="px-4 py-2 text-gray-900 dark:text-white">{l.title}</td>
                  <td className="px-4 py-2 text-right text-gray-500">{onHandOf(i) ?? '…'}</td>
                  <td className="px-4 py-2 text-right">
                    <input type="number" min={1} aria-label={`Quantity of ${l.title}`} value={l.quantity} aria-invalid={problems[i] ? true : undefined}
                      onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                      className={`${INPUT} text-right`} />
                    {problems[i] && <p className="text-xs mt-1 text-red-500">{problems[i]}</p>}
                  </td>
                  <td className="px-2 text-center">
                    <button type="button" aria-label={`Remove ${l.title}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      className="text-gray-400 hover:text-red-500">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <label htmlFor="transfer-notes" className={LABEL}>Notes</label>
          <textarea id="transfer-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className={INPUT} />
        </div>

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">Back</button>
          <button type="button" disabled={!ready || busy} onClick={saveDraft}
            className="px-4 py-2 text-sm rounded-lg border border-blue-600 text-blue-600 dark:text-blue-400 disabled:opacity-50">Save draft</button>
          <button type="button" disabled={!ready || busy} onClick={() => setConfirming(true)}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">Dispatch</button>
        </div>
      </div>

      {confirming && (
        <ActionDialog
          title={`Dispatch to ${toName}`}
          message={`${lines.reduce((s, l) => s + Number(l.quantity), 0)} copies leave ${fromName} now and are in transit until ${toName} receives them.`}
          confirmLabel="Dispatch"
          busy={busy}
          onConfirm={saveAndDispatch}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
