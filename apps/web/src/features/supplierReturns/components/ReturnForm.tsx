import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PurchaseOrder, SupplierReturnDetail, SupplierReturnSource } from '@bms/shared';
import { useMyProfile } from '../../account/queries.js';
import { findStockLevel } from '../../inventory/api.js';
import { canUseLocation } from '../../inventory/rules.js';
import { inventoryKeys } from '../../inventory/queries.js';
import { useLocations } from '../../locations/queries.js';
import { useSaveSupplierReturn } from '../queries.js';
import { returnable } from '../rules.js';

const FIELD = 'border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

type Line = NonNullable<PurchaseOrder['lineItems']>[number];
type Entry = { key: number; locationId: number; source: SupplierReturnSource; quantity: string };

let nextKey = 1;

/** What a location holds of the book: for sale and damaged (#173, decision 2a). */
function Held({ bookId, locationId }: { bookId: number; locationId: number }) {
  const level = useQuery({
    queryKey: inventoryKeys.levels({ bookId, locationId, is_active: 'all', pageSize: 1 }),
    queryFn: () => findStockLevel(bookId, locationId),
  });
  if (level.isLoading) return null;
  return <span className="text-xs text-gray-500 dark:text-gray-400">On hand {level.data?.quantity ?? 0} · damaged {level.data?.damaged ?? 0}</span>;
}

/**
 * A return of an order's lines (#173, decisions 1a, 2a): per line, copies from
 * one or more locations one may use, from stock or damaged copies, at most
 * what arrived less what went back.
 */
export function ReturnForm({ po, draft = null, onDone, onCancel }: {
  po: PurchaseOrder;
  draft?: SupplierReturnDetail | null;
  onDone: (id: number) => void;
  onCancel: () => void;
}) {
  const { data: me } = useMyProfile();
  const { data: locationList } = useLocations(po.receivingBranchId);
  const locations = (locationList?.items ?? []).filter((l) => canUseLocation(me, l.id));
  const fallback = locations.find((l) => l.id === po.receivingLocationId)?.id ?? locations[0]?.id ?? null;
  const lines = (po.lineItems ?? []).filter((l) => returnable(l) > 0 || draft?.lines.some((d) => d.poLineItemId === l.id));
  const [entries, setEntries] = useState<Record<string, Entry[]>>(() => Object.fromEntries(lines.map((l) => {
    const drafted = (draft?.lines ?? []).filter((d) => d.poLineItemId === l.id);
    return [l.id, drafted.map((d) => ({ key: nextKey++, locationId: d.locationId, source: d.source, quantity: String(d.quantity) }))];
  })));
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [problem, setProblem] = useState('');
  const save = useSaveSupplierReturn(draft?.id ?? null);

  // A line with no entry yet takes one at the order's receiving location once the locations are known.
  const entriesOf = (line: Line): Entry[] =>
    entries[line.id]?.length ? entries[line.id] : fallback === null ? [] : [{ key: -Number(line.id), locationId: fallback, source: 'stock', quantity: '' }];
  const change = (line: Line, key: number, patch: Partial<Entry>) =>
    setEntries((all) => ({ ...all, [line.id]: entriesOf(line).map((e) => (e.key === key ? { ...e, ...patch } : e)) }));
  const addEntry = (line: Line) => {
    const used = new Set(entriesOf(line).map((e) => e.locationId));
    const locationId = locations.find((l) => !used.has(l.id))?.id ?? fallback;
    if (locationId === null) return;
    setEntries((all) => ({ ...all, [line.id]: [...entriesOf(line), { key: nextKey++, locationId, source: 'stock', quantity: '' }] }));
  };
  const remove = (line: Line, key: number) => setEntries((all) => ({ ...all, [line.id]: entriesOf(line).filter((e) => e.key !== key) }));
  const nameOf = (locationId: number) => locations.find((l) => l.id === locationId)?.name ?? `Location ${locationId}`;

  function submit() {
    const body: Array<{ poLineItemId: number; locationId: number; source: SupplierReturnSource; quantity: number }> = [];
    for (const line of lines) {
      const chosen = entriesOf(line).filter((e) => e.quantity.trim() !== '');
      if (chosen.some((e) => !/^\d+$/.test(e.quantity.trim()))) return setProblem(`${line.bookTitle}: enter whole copies`);
      if (new Set(chosen.map((e) => `${e.locationId}:${e.source}`)).size < chosen.length) return setProblem(`${line.bookTitle}: each location and source once`);
      const total = chosen.reduce((n, e) => n + Number(e.quantity), 0);
      if (total > returnable(line)) return setProblem(`${line.bookTitle}: at most ${returnable(line)} can go back`);
      for (const e of chosen) {
        if (Number(e.quantity) > 0) body.push({ poLineItemId: Number(line.id), locationId: e.locationId, source: e.source, quantity: Number(e.quantity) });
      }
    }
    if (body.length === 0) return setProblem('Enter at least one copy to send back');
    setProblem('');
    save.mutate(
      { poId: Number(po.id), notes: notes.trim() || null, lines: body },
      { onSuccess: (r) => onDone(r.id), onError: (e) => setProblem((e as Error).message) },
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{draft ? `Edit ${draft.returnNumber}` : 'Return to Supplier'}</h2>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300">{po.poNumber} · {po.supplierName}. The supplier credits the order's price; the copies leave when the return is sent.</p>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
        {lines.map((line) => (
          <div key={line.id} className="p-4 space-y-2">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-medium text-gray-900 dark:text-white">{line.bookTitle}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{returnable(line)} of {line.receivedQuantity} can go back</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">at {po.currency} {line.unitCost.toFixed(2)}</span>
            </div>
            {entriesOf(line).map((e) => (
              <div key={e.key} className="flex flex-wrap items-center gap-2">
                <select aria-label={`Location for ${line.bookTitle}`} value={e.locationId} className={FIELD}
                  onChange={(ev) => change(line, e.key, { locationId: Number(ev.target.value) })}>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <select aria-label={`From for ${line.bookTitle}`} value={e.source} className={FIELD}
                  onChange={(ev) => change(line, e.key, { source: ev.target.value as SupplierReturnSource })}>
                  <option value="stock">Stock for sale</option>
                  <option value="damaged">Damaged copies</option>
                </select>
                <input type="text" inputMode="numeric" aria-label={`Quantity of ${line.bookTitle} from ${nameOf(e.locationId)}`} value={e.quantity}
                  placeholder="0" onChange={(ev) => change(line, e.key, { quantity: ev.target.value })} className={`w-20 text-right ${FIELD}`} />
                <Held bookId={line.bookId} locationId={e.locationId} />
                {entriesOf(line).length > 1 && (
                  <button type="button" aria-label={`Remove ${nameOf(e.locationId)} for ${line.bookTitle}`} onClick={() => remove(line, e.key)}
                    className="text-gray-400 hover:text-red-500">✕</button>
                )}
              </div>
            ))}
            {locations.length > 1 && (
              <button type="button" onClick={() => addEntry(line)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                aria-label={`+ another location for ${line.bookTitle}`}>+ another location</button>
            )}
          </div>
        ))}
      </div>

      <div>
        <label htmlFor="return-notes" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
        <textarea id="return-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)}
          className={`w-full ${FIELD}`} placeholder="Why the books go back" />
      </div>
      {problem && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{problem}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">Cancel</button>
        <button type="button" onClick={submit} disabled={save.isPending}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">Save Draft</button>
      </div>
    </div>
  );
}
