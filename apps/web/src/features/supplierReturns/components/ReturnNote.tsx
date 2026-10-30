import type { SupplierReturnDetail } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';

/** The note that goes with the books (#173, decision 3a): what goes back, at the order's price, signed by both sides. */
export function ReturnNote({ r, onClose }: { r: SupplierReturnDetail; onClose: () => void }) {
  const currency = useCurrency();
  const money = (n: number) => formatCurrency(n, currency);
  return (
    <PrintSlip title={`Return note ${r.returnNumber}`} onClose={onClose}>
      <div className="space-y-1">
        <SlipRow label="Supplier">{r.supplierName}</SlipRow>
        <SlipRow label="Order">{r.poNumber}</SlipRow>
        <SlipRow label="Date">{new Date(r.sentAt ?? r.createdAt).toLocaleDateString()}</SlipRow>
        {r.notes && <SlipRow label="Reason">{r.notes}</SlipRow>}
      </div>
      <table className="w-full text-sm border-t border-gray-200 dark:border-gray-700">
        <thead><tr className="text-xs text-gray-500"><th className="py-1 text-left">Book</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Price</th><th className="py-1 text-right">Credit</th></tr></thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.id} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1.5">{l.bookTitle}{l.isbn && <span className="block text-xs text-gray-500">{l.isbn}</span>}</td>
              <td className="py-1.5 text-right">{l.quantity}</td>
              <td className="py-1.5 text-right">{money(l.unitCredit)}</td>
              <td className="py-1.5 text-right">{money(l.creditValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <SlipRow label="Total credit">{money(r.creditValue)}</SlipRow>
      <div className="grid grid-cols-2 gap-6 pt-6 text-sm">
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Handed over by</p></div>
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Received by (supplier)</p></div>
      </div>
    </PrintSlip>
  );
}
