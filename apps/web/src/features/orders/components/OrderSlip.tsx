import { Money } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { paymentMethodPlainLabel } from '../../../lib/paymentMethods.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useCustomer } from '../../customers/queries.js';
import { useOrder } from '../queries.js';

const SALE_TYPE: Record<string, string> = { cash_sale: 'Cash sale', credit_sale: 'Credit sale' };

/** An order as the customer takes it away: its books, totals, and how it is paid. */
export function OrderSlip({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const currency = useCurrency();
  const { data: order } = useOrder(orderId);
  const { data: customer } = useCustomer(order?.customerId ?? null);
  const money = (n: number) => `${currency} ${Money.of(n).toFixed()}`;

  return (
    <PrintSlip title={order ? `Order ${order.orderNumber}` : 'Order'} onClose={onClose}>
      {!order?.lineItems ? <p className="text-sm text-gray-400">Loading...</p> : (
        <>
          <div className="space-y-1">
            <SlipRow label="Date">{new Date(order.createdAt).toLocaleString()}</SlipRow>
            <SlipRow label="Channel"><span className="capitalize">{order.channel.replace('_', ' ')}</span></SlipRow>
            {customer && <SlipRow label="Customer">{customer.fullName} ({customer.customerCode})</SlipRow>}
            <SlipRow label="Sale">{SALE_TYPE[order.saleType] ?? order.saleType}</SlipRow>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-1 pr-2 font-medium">Book</th>
                <th className="py-1 pr-2 font-medium text-right">Qty</th>
                <th className="py-1 pr-2 font-medium text-right">Price</th>
                <th className="py-1 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.lineItems.map((li) => (
                <tr key={li.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-1 pr-2">{li.bookTitle}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{li.quantity}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{Money.of(li.unitPrice).toFixed()}</td>
                  <td className="py-1 text-right tabular-nums">{Money.of(li.totalPrice).toFixed()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-1">
            <SlipRow label="Subtotal">{money(order.subtotal)}</SlipRow>
            {order.discountTotal > 0 && <SlipRow label="Discount">− {money(order.discountTotal)}</SlipRow>}
            {order.taxAmount > 0 && <SlipRow label="Tax">{money(order.taxAmount)}</SlipRow>}
            <SlipRow label="Total"><span className="font-bold">{money(order.total)}</span></SlipRow>
            {order.paymentMethod && <SlipRow label="Paid by">{paymentMethodPlainLabel(order.paymentMethod)}</SlipRow>}
            {order.dueDate && <SlipRow label="Due date">{order.dueDate}</SlipRow>}
            <SlipRow label="Payment"><span className="capitalize">{order.paymentStatus}</span></SlipRow>
          </div>
        </>
      )}
    </PrintSlip>
  );
}
