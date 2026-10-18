import { useEffect, useState } from 'react';
import type { PurchaseOrder } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useLocations } from '../../locations/queries.js';
import { usePurchaseOrder, useReceivePurchaseOrder } from '../queries.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * Goods arriving for an order, at a location of the receiving branch. Staff
 * limited to some locations are offered only theirs (#72), as the API checks.
 */
export function ReceiveGoodsForm({ order, onDone, onBack }: {
  order: PurchaseOrder;
  onDone: (updated: PurchaseOrder) => void;
  onBack: () => void;
}) {
  const { showToast } = useToast();
  // The full order, with its lines.
  const { data: po, isLoading } = usePurchaseOrder(order.id);
  const { data: locData } = useLocations((po ?? order).receivingBranchId);
  const locations = locData?.items ?? [];
  const [locationId, setLocationId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const receive = useReceivePurchaseOrder(order.id);

  // The order's receiving location, else the default one, else the first (was: set while rendering).
  useEffect(() => {
    if (locationId !== null || locations.length === 0) return;
    const preferred = locations.find(l => l.id === (po ?? order).receivingLocationId)
      ?? locations.find(l => l.isDefaultFulfillment) ?? locations[0];
    setLocationId(preferred.id);
  }, [locations, locationId, po, order]);

  const lines = (po?.lineItems ?? []).filter(li => li.remaining > 0);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!locationId) { setProblem('Please select a location'); return; }
    // Whole copies, at most what is still expected.
    const bad = lines.find(li => {
      const q = (quantities[li.id] ?? '').trim();
      return q !== '' && (!/^\d+$/.test(q) || Number(q) > li.remaining);
    });
    if (bad) { setProblem(`Enter a whole number of copies for "${bad.bookTitle}", at most ${bad.remaining}`); return; }
    // The contract's limit, checked before sending (was: sent and refused).
    if (notes.length > 2000) { setProblem('Notes can be at most 2000 characters'); return; }
    const items = lines
      .map(li => ({ poLineItemId: Number(li.id), quantityReceived: Number((quantities[li.id] ?? '').trim() || 0) }))
      .filter(i => i.quantityReceived > 0);
    if (!items.length) { setProblem('Enter quantity for at least one item'); return; }
    setProblem('');
    receive.mutate({ locationId, items, notes: notes || null }, {
      onSuccess: (updated) => { showToast('Goods received', 'success'); onDone(updated); },
      onError: (err: Error) => showToast(err.message, 'error'),
    });
  }

  const title = `Receive Goods — ${(po ?? order).poNumber}`;
  if (isLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to PO</button>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        </div>
        <div className="p-8 text-center text-gray-400">Loading PO details...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5 pb-8">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to PO</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {problem && <p role="alert" className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{problem}</p>}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
          <div>
            <label htmlFor="receive-location" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Destination Location *</label>
            <select id="receive-location" value={locationId ?? ''} onChange={e => setLocationId(Number(e.target.value) || null)} className={INPUT}>
              <option value="">Select location...</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="receive-notes" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea id="receive-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} className={`${INPUT} resize-none`} />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Book', 'Ordered', 'Received', 'Remaining', 'Qty to Receive'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {lines.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">All items have been fully received.</td></tr>
              ) : lines.map(li => (
                <tr key={li.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-900 dark:text-white">{li.bookTitle}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.quantity}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.receivedQuantity}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.remaining}</td>
                  <td className="px-4 py-3">
                    <input type="number" min={0} max={li.remaining} value={quantities[li.id] ?? '0'} aria-label={`Quantity to receive of ${li.bookTitle}`}
                      onChange={e => setQuantities(q => ({ ...q, [li.id]: e.target.value }))}
                      className="w-20 border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onBack} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Back</button>
          <button type="submit" disabled={receive.isPending} className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{receive.isPending ? 'Submitting...' : 'Submit Receipt'}</button>
        </div>
      </form>
    </div>
  );
}
