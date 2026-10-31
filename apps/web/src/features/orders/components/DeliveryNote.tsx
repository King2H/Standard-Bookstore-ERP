import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { useMyProfile } from '../../account/queries.js';
import { useCustomer } from '../../customers/queries.js';
import { useOrder } from '../queries.js';

/**
 * A delivery's note (#174, decision 2a): the copies handed over and, per
 * line, what was still to deliver after it, as it stood then.
 */
export function DeliveryNote({ orderId, deliveryId, onClose }: { orderId: string; deliveryId: number; onClose: () => void }) {
  const { data: order } = useOrder(orderId);
  const { data: me } = useMyProfile();
  const { data: customer } = useCustomer(order?.customerId ?? null);
  const deliveries = order?.deliveries ?? [];
  const index = deliveries.findIndex((d) => d.id === deliveryId);
  const delivery = deliveries[index];
  const branch = me?.roles.find((r) => r.branchId === order?.branchId)?.branchName;

  // Copies of a line delivered up to and including this delivery.
  const deliveredBy = (lineId: string) => deliveries.slice(0, index + 1)
    .flatMap((d) => d.lines).filter((l) => l.orderLineItemId === lineId).reduce((n, l) => n + l.quantity, 0);
  const rows = (order?.lineItems ?? []).map((li) => ({
    li, now: delivery?.lines.find((l) => l.orderLineItemId === li.id)?.quantity ?? 0, left: li.quantity - deliveredBy(li.id),
  })).filter((r) => r.now > 0 || r.left > 0);

  return (
    <PrintSlip title={delivery ? `Delivery ${delivery.deliveryNumber}` : 'Delivery'} onClose={onClose}>
      {!order || !delivery ? <p className="text-sm text-gray-400">Loading...</p> : (
        <>
          <div className="space-y-1">
            {branch && <SlipRow label="Branch">{branch}</SlipRow>}
            <SlipRow label="Order">{order.orderNumber}</SlipRow>
            <SlipRow label="Date">{new Date(delivery.deliveredAt).toLocaleString()}</SlipRow>
            {customer && <SlipRow label="Customer">{customer.fullName} ({customer.customerCode})</SlipRow>}
            <SlipRow label="Handed over by">{delivery.deliveredByName}</SlipRow>
            {delivery.notes && <SlipRow label="Notes">{delivery.notes}</SlipRow>}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-1 pr-2 font-medium">Book</th>
                <th className="py-1 pr-2 font-medium text-right">Delivered</th>
                <th className="py-1 font-medium text-right">Still to deliver</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ li, now, left }) => (
                <tr key={li.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-1 pr-2">{li.bookTitle}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{now}</td>
                  <td className="py-1 text-right tabular-nums">{left}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pt-6 grid grid-cols-2 gap-6 text-xs text-gray-500 dark:text-gray-400">
            <div className="border-t border-gray-300 dark:border-gray-600 pt-1">Received by (name, signature)</div>
            <div className="border-t border-gray-300 dark:border-gray-600 pt-1">Date</div>
          </div>
        </>
      )}
    </PrintSlip>
  );
}
