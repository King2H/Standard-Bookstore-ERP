import { useState } from 'react';
import type { SpecialOrderLine } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { SearchPicker, type PickerOption } from '../../../shared/components/SearchPicker.js';
import { searchSuppliersToBuyFrom } from '../../procurement/api.js';
import { usePurchaseOrders } from '../../procurement/queries.js';
import { useLinkSpecialOrders, useSpecialOrders, useStartPurchaseOrder } from '../queries.js';

const FIELD = 'border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';
const MONEY = /^\d+(\.\d{1,2})?$/;

type Choice = { quantity: string; unitCost: string };

/**
 * The copies customers ordered that no purchase order brings yet (#174,
 * decision 3a): ticked, they go on a draft purchase order of the branch, or
 * start one for a supplier at the unit costs entered.
 */
export function SpecialOrdersTab({ onOpenOrder }: { onOpenOrder: (poId: string) => void }) {
  const { showToast } = useToast();
  const { data, isLoading } = useSpecialOrders({ toOrder: true, pageSize: 100 });
  const { data: drafts } = usePurchaseOrders({ status: 'draft', pageSize: 100 });
  const [chosen, setChosen] = useState<Record<string, Choice>>({});
  const [target, setTarget] = useState<'draft' | 'new' | null>(null);
  const [draftId, setDraftId] = useState('');
  const [supplier, setSupplier] = useState<PickerOption | null>(null);
  const link = useLinkSpecialOrders();
  const start = useStartPurchaseOrder();
  const lines = data?.items ?? [];
  const draftList = drafts?.items ?? [];
  const into = target ?? (draftList.length > 0 ? 'draft' : 'new');
  const busy = link.isPending || start.isPending;

  const toggle = (l: SpecialOrderLine, on: boolean) => setChosen((c) => {
    const next = { ...c };
    if (on) next[l.orderLineId] = { quantity: String(l.toOrder), unitCost: '' };
    else delete next[l.orderLineId];
    return next;
  });
  const change = (id: string, patch: Partial<Choice>) => setChosen((c) => ({ ...c, [id]: { ...c[id], ...patch } }));

  function submit() {
    const picked = lines.filter((l) => chosen[l.orderLineId]);
    if (picked.length === 0) return showToast('Tick the copies to buy', 'error');
    for (const l of picked) {
      const { quantity, unitCost } = chosen[l.orderLineId];
      if (!/^\d+$/.test(quantity.trim()) || Number(quantity) < 1 || Number(quantity) > l.toOrder) {
        return showToast(`${l.bookTitle} for ${l.orderNumber}: 1 to ${l.toOrder} copies`, 'error');
      }
      if (unitCost.trim() !== '' && !MONEY.test(unitCost.trim())) return showToast(`${l.bookTitle}: enter the unit cost as an amount`, 'error');
      if (into === 'new' && unitCost.trim() === '') return showToast(`${l.bookTitle}: enter its unit cost`, 'error');
    }
    const body = picked.map((l) => {
      const { quantity, unitCost } = chosen[l.orderLineId];
      return { orderLineId: Number(l.orderLineId), quantity: Number(quantity), ...(unitCost.trim() !== '' && { unitCost: unitCost.trim() }) };
    });
    const done = (po: { id: string; poNumber: string }) => { setChosen({}); showToast(`Added to ${po.poNumber}`, 'success'); onOpenOrder(po.id); };
    const failed = (e: Error) => showToast(e.message, 'error');
    if (into === 'draft') {
      if (!draftId) return showToast('Choose the draft purchase order', 'error');
      link.mutate({ poId: draftId, body: { lines: body } }, { onSuccess: done, onError: failed });
    } else {
      if (!supplier) return showToast('Choose the supplier', 'error');
      start.mutate({ supplierId: supplier.id, specialOrders: body }, { onSuccess: done, onError: failed });
    }
  }

  return (
    <div className="p-6 space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300">Books customers ordered that no purchase order brings yet, oldest order first. When they arrive they are reserved for the order.</p>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        {isLoading ? <p className="p-6 text-center text-gray-400">Loading...</p> : lines.length === 0 ? (
          <p className="p-6 text-center text-sm text-gray-400">No special order waits to be bought</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>{['', 'Order', 'Customer', 'Book', 'To order', 'Copies', 'Unit cost'].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {lines.map((l) => {
                const c = chosen[l.orderLineId];
                return (
                  <tr key={l.orderLineId}>
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Buy ${l.bookTitle} for ${l.orderNumber}`} checked={!!c} onChange={(e) => toggle(l, e.target.checked)} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{l.orderNumber}</td>
                    <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{l.customerName ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-900 dark:text-white">{l.bookTitle}<span className="block text-xs text-gray-400">{l.isbn}</span></td>
                    <td className="px-3 py-2 tabular-nums">{l.toOrder}</td>
                    <td className="px-3 py-2">
                      {c && <input type="text" inputMode="numeric" aria-label={`Copies of ${l.bookTitle} for ${l.orderNumber}`} value={c.quantity}
                        onChange={(e) => change(l.orderLineId, { quantity: e.target.value })} className={`w-16 text-right ${FIELD}`} />}
                    </td>
                    <td className="px-3 py-2">
                      {c && <input type="text" inputMode="decimal" aria-label={`Unit cost of ${l.bookTitle}`} value={c.unitCost}
                        placeholder={into === 'new' ? 'Required' : 'If new on the order'}
                        onChange={(e) => change(l.orderLineId, { unitCost: e.target.value })} className={`w-28 text-right ${FIELD}`} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {lines.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
            <input type="radio" name="special-target" checked={into === 'draft'} onChange={() => setTarget('draft')} disabled={draftList.length === 0} />
            Add to a draft purchase order
          </label>
          {into === 'draft' && (
            <select aria-label="Draft purchase order" value={draftId} onChange={(e) => setDraftId(e.target.value)} className={`ml-6 ${FIELD}`}>
              <option value="">Choose…</option>
              {draftList.map((po) => <option key={po.id} value={po.id}>{po.poNumber} · {po.supplierName}</option>)}
            </select>
          )}
          <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
            <input type="radio" name="special-target" checked={into === 'new'} onChange={() => setTarget('new')} />
            A new draft for a supplier
          </label>
          {into === 'new' && (
            <div className="ml-6 max-w-sm">
              <SearchPicker value={supplier} onChange={setSupplier} search={searchSuppliersToBuyFrom} queryKey="special-order-suppliers"
                placeholder="Type to search suppliers…" aria-label="Supplier" className={`w-full ${FIELD}`} />
            </div>
          )}
          <button type="button" onClick={submit} disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
            {into === 'draft' ? 'Add to purchase order' : 'Create draft purchase order'}
          </button>
        </div>
      )}
    </div>
  );
}
