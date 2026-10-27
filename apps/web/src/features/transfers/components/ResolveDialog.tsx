import { useState } from 'react';
import type { Transfer, TransferLine, TransferOutcome } from '@bms/shared';
import { getCurrentBranchId } from '../../../lib/api.js';
import { useMyProfile } from '../../account/queries.js';
import { canUseLocation } from '../../inventory/rules.js';
import { useLocations } from '../../locations/queries.js';
import { useResolveTransfer } from '../queries.js';
import { OUTCOME_LABELS, outcomesFor, type Side } from '../rules.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';
const LABEL = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

/**
 * Copies of a line that did not arrive, resolved by an Admin or Manager with a
 * reason (#170, decision 4a): the receiving branch says lost or damaged
 * (damaged into one of its locations), the sending branch says returned (onto
 * one of its locations).
 */
export function ResolveDialog({ transfer, line, side, onClose }: { transfer: Transfer; line: TransferLine; side: Side; onClose: () => void }) {
  const { data: me } = useMyProfile();
  const { data: locationList } = useLocations(getCurrentBranchId());
  const locations = (locationList?.items ?? []).filter((l) => canUseLocation(me, l.id));
  const outcomes = outcomesFor(side);
  const [outcome, setOutcome] = useState<TransferOutcome>(outcomes[0]);
  const [quantity, setQuantity] = useState(String(line.outstandingQuantity));
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const resolve = useResolveTransfer();

  const needsLocation = outcome !== 'lost';
  const qty = Number(quantity);
  const problems = {
    quantity: !/^\d+$/.test(quantity.trim()) || qty < 1 ? 'Enter a whole number of copies'
      : qty > line.outstandingQuantity ? `Only ${line.outstandingQuantity} still on the way` : '',
    location: needsLocation && !locationId ? 'Choose a location' : '',
    reason: !reason.trim() ? 'A reason is required' : reason.trim().length > 500 ? 'At most 500 characters' : '',
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (problems.quantity || problems.location || problems.reason) return;
    setError('');
    resolve.mutate({
      id: transfer.id,
      body: { lineId: line.id, outcome, quantity: qty, reason: reason.trim(), ...(needsLocation && { locationId: Number(locationId) }) },
    }, { onSuccess: onClose, onError: (err) => setError((err as Error).message) });
  }

  const shown = (p: string) => tried && p ? <p role="alert" className="text-xs mt-1 text-red-500">{p}</p> : null;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="resolve-title" onSubmit={submit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="resolve-title" className="text-base font-semibold text-gray-900 dark:text-white">Resolve {line.bookTitle}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">{line.outstandingQuantity} of {line.quantity} copies on {transfer.transferNumber} are still on the way.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div>
          <label htmlFor="resolve-outcome" className={LABEL}>What happened</label>
          <select id="resolve-outcome" className={INPUT} value={outcome} onChange={(e) => setOutcome(e.target.value as TransferOutcome)}>
            {outcomes.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="resolve-quantity" className={LABEL}>Copies</label>
          <input id="resolve-quantity" type="number" min={1} max={line.outstandingQuantity} className={INPUT} value={quantity}
            onChange={(e) => setQuantity(e.target.value)} aria-invalid={tried && problems.quantity ? true : undefined} />
          {shown(problems.quantity)}
        </div>
        {needsLocation && (
          <div>
            <label htmlFor="resolve-location" className={LABEL}>Into location</label>
            <select id="resolve-location" className={INPUT} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">— Select location —</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
            {outcome === 'damaged' && <p className="text-xs mt-1 text-gray-500">Kept apart as damaged, at the cost the copies left at.</p>}
            {shown(problems.location)}
          </div>
        )}
        <div>
          <label htmlFor="resolve-reason" className={LABEL}>Reason</label>
          <textarea id="resolve-reason" rows={3} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)}
            aria-invalid={tried && problems.reason ? true : undefined} />
          {shown(problems.reason)}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">Back</button>
          <button type="submit" disabled={resolve.isPending} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">Resolve</button>
        </div>
      </form>
    </div>
  );
}
