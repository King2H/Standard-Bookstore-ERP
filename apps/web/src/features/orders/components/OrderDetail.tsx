import { Fragment, useState, type ReactNode } from 'react';
import { Money } from '@bms/shared';
import { paymentMethodLabel } from '../../../lib/paymentMethods.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useReturns } from '../../returns/queries.js';
import { refundLabel } from '../../returns/rules.js';
import { useMyProfile } from '../../account/queries.js';
import { ServiceJobLine } from '../../services/components/ServiceJobLine.js';
import { orderKeys, useOrder } from '../queries.js';
import { canCreateOrder } from '../rules.js';
import { DeliveryNote } from './DeliveryNote.js';

/** The order's stage, from its status, old names included. */
function stageOf(status: string): 'DRAFT' | 'CONFIRMED' | 'PART' | 'FULFILLED' | 'CANCELLED' | null {
  if (['DRAFT', 'Pending'].includes(status)) return 'DRAFT';
  if (status === 'PART_DELIVERED') return 'PART';
  if (['CONFIRMED', 'PAID', 'Confirmed', 'In_Progress'].includes(status)) return 'CONFIRMED';
  if (['FULFILLED', 'COMPLETED', 'Fulfilled'].includes(status)) return 'FULFILLED';
  if (['CANCELLED', 'Cancelled'].includes(status)) return 'CANCELLED';
  return null;
}

/** An order's lines, with where their stock stands at the order's stage. */
export function OrderDetail({ orderId }: { orderId: string }) {
  const currency = useCurrency();
  const { data } = useOrder(orderId);
  const { data: me } = useMyProfile();
  const [note, setNote] = useState<number | null>(null);
  const stage = data ? stageOf(data.status) : null;
  // What came back of a delivered order (#166, owner decision 4a): it stays completed.
  const { data: returns } = useReturns({ orderId, pageSize: 50 }, stage === 'FULFILLED' || stage === 'PART');
  if (!data?.lineItems) return <p className="text-xs text-gray-400">Loading...</p>;
  const anyReturned = data.lineItems.some((li) => li.qtyReturned > 0);
  // Copies never delivered, cancelled with the rest (#174).
  const anyCancelled = data.lineItems.some((li) => li.qtyCancelled > 0);
  const columns = 6 + (anyReturned ? 1 : 0) + (anyCancelled ? 1 : 0);
  const deliveries = data.deliveries ?? [];

  return (
    <>
      {(data.paymentMethod || data.dueDate) && (
        <div className="flex gap-4 mb-2 text-xs text-gray-600 dark:text-gray-400">
          {data.paymentMethod && (
            <span>💳 Payment method: <span className="font-medium text-gray-900 dark:text-white">{paymentMethodLabel(data.paymentMethod)}</span></span>
          )}
          {data.dueDate && (
            <span>📅 Due date: <span className="font-medium text-gray-900 dark:text-white">{data.dueDate}</span></span>
          )}
        </div>
      )}
      <table className="text-xs w-full max-w-2xl">
        <thead>
          <tr className="text-gray-500 dark:text-gray-400">
            {['Book', 'Ordered', 'Reserved', 'Fulfilled', ...(anyCancelled ? ['Cancelled'] : []), ...(anyReturned ? ['Returned'] : []), 'Stock State', 'Price'].map((h) => (
              <th key={h} className="text-left pr-4 pb-1">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.lineItems.map((li) => {
            // The order's stage says where the stock stands; the line counts may lag behind it.
            let reserved = li.qtyReserved;
            let fulfilled = li.qtyFulfilled;
            let state: ReactNode = <span className="text-gray-400">—</span>;
            if (stage === 'DRAFT') {
              reserved = 0; fulfilled = 0;
              state = <span className="text-gray-400 italic">Pending confirmation</span>;
            } else if (stage === 'CONFIRMED') {
              reserved = li.qtyReserved > 0 ? li.qtyReserved : li.quantity;
              state = <span className="text-blue-600 dark:text-blue-400 font-medium">🔒 Stock reserved</span>;
            } else if (stage === 'PART') {
              // Delivered in parts (#174): the counts are the record.
              state = li.qtyReserved > 0
                ? <span className="text-teal-600 dark:text-teal-400 font-medium">Waiting {li.qtyReserved}</span>
                : <span className="text-green-600 dark:text-green-400 font-medium">✓ Delivered</span>;
            } else if (stage === 'FULFILLED') {
              reserved = 0;
              // An order delivered before the line counts were kept shows its quantity; one with a cancelled rest, what it delivered.
              fulfilled = li.qtyFulfilled > 0 || li.qtyCancelled > 0 ? li.qtyFulfilled : li.quantity;
              state = <span className="text-green-600 dark:text-green-400 font-medium">✓ Fulfilled</span>;
            } else if (stage === 'CANCELLED') {
              reserved = 0; fulfilled = 0;
              state = <span className="text-red-500 dark:text-red-400 italic">Stock restored</span>;
            }
            return (
              <Fragment key={li.id}>
              <tr className="border-t border-gray-100 dark:border-gray-700">
                <td className="pr-4 py-1.5 text-gray-900 dark:text-white">{li.bookTitle}</td>
                <td className="pr-4 text-gray-600 dark:text-gray-400">{li.quantity}</td>
                <td className={`pr-4 font-medium ${reserved > 0 ? 'text-orange-500 dark:text-orange-400' : 'text-gray-400'}`}>{reserved}</td>
                <td className={`pr-4 font-medium ${fulfilled > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>{fulfilled}</td>
                {anyCancelled && <td className={`pr-4 font-medium ${li.qtyCancelled > 0 ? 'text-red-500 dark:text-red-400' : 'text-gray-400'}`}>{li.qtyCancelled}</td>}
                {anyReturned && <td className={`pr-4 font-medium ${li.qtyReturned > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'}`}>{li.qtyReturned}</td>}
                <td className="pr-4">{state}</td>
                <td className="text-gray-900 dark:text-white">{currency} {Money.of(li.totalPrice).toFixed()}</td>
              </tr>
              {li.service && (
                <tr>
                  <td colSpan={columns} className="pb-1.5 pl-4">
                    {/* An order's binding job moves on while the order waits; it is collected at delivery (#169). */}
                    <ServiceJobLine line={li.service} canStep={canCreateOrder(me) && (stage === 'CONFIRMED' || stage === 'PART')} onOrder refresh={[orderKeys.all]} />
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {deliveries.length > 0 && (
        <div className="mt-3 text-xs">
          <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">Deliveries</p>
          <ul className="space-y-0.5 text-gray-600 dark:text-gray-400">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-1">
                <span className="font-mono">{d.deliveryNumber}</span> · {new Date(d.deliveredAt).toLocaleString()} · {d.deliveredByName} ·{' '}
                {d.lines.map((l) => `${l.bookTitle} × ${l.quantity}`).join(', ')}
                {d.notes && <> · <span className="italic">{d.notes}</span></>}
                <button type="button" aria-label={`Delivery note ${d.deliveryNumber}`} onClick={(e) => { e.stopPropagation(); setNote(d.id); }}
                  className="ml-1 px-1.5 rounded-sm text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700">🖨 Note</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {note !== null && <DeliveryNote orderId={orderId} deliveryId={note} onClose={() => setNote(null)} />}
      {returns && returns.items.length > 0 && (
        <div className="mt-3 text-xs">
          <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">Returns</p>
          <ul className="space-y-0.5 text-gray-600 dark:text-gray-400">
            {returns.items.map((r) => (
              <li key={r.id}>
                <span className="font-mono">{r.returnNumber}</span> · {new Date(r.createdAt).toLocaleDateString()} · {currency} {Money.of(r.totalRefundAmount).toFixed()} · {refundLabel(r.refundMethod)}{r.undelivered && ' · not delivered'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
