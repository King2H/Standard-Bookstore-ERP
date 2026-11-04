import { Money } from '@bms/shared';
import { PrintSlip } from '../../../components/PrintSlip.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useReturn } from '../queries.js';
import { refundLabel } from '../rules.js';

/**
 * The return slip to hand to the customer (#240, R2; was: none): the shop's
 * header, the sale it returns, the books, why, and how the money went back.
 */
export function ReturnSlip({ returnId, onClose }: { returnId: string; onClose: () => void }) {
  const currency = useCurrency();
  const { data } = useReturn(returnId);
  const sale = data?.transactionNumber ?? data?.orderNumber ?? null;
  return (
    <PrintSlip title={data ? `Return ${data.returnNumber}` : 'Return'} onClose={onClose}>
      {!data?.lineItems ? <p className="text-sm text-gray-400">Loading...</p> : (
        <div className="space-y-3 text-sm">
          <p className="text-gray-600 dark:text-gray-400">
            {new Date(data.createdAt).toLocaleString()}{sale && <> · for {sale}</>}
          </p>
          <table className="w-full">
            <thead><tr className="text-left text-xs text-gray-500 dark:text-gray-400"><th className="pb-1">Book</th><th className="pb-1 text-right">Qty</th><th className="pb-1 text-right">Value</th></tr></thead>
            <tbody>
              {data.lineItems.map((li) => (
                <tr key={li.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1">{li.bookTitle}</td>
                  <td className="py-1 text-right tabular-nums">{li.quantity}</td>
                  <td className="py-1 text-right tabular-nums">{currency} {Money.of(li.lineRefundAmount).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data.refunds ?? []).map((r) => (
            <div key={r.id} className="flex justify-between"><span>{refundLabel(r.method)}</span><span className="tabular-nums">{currency} {Money.of(r.amount).toFixed(2)}</span></div>
          ))}
          <div className="flex justify-between font-semibold border-t border-gray-200 dark:border-gray-700 pt-2">
            <span>Total</span><span className="tabular-nums">{currency} {Money.of(data.totalRefundAmount).toFixed(2)}</span>
          </div>
          {data.reason && <p className="text-gray-600 dark:text-gray-400">Reason: {data.reason}</p>}
        </div>
      )}
    </PrintSlip>
  );
}
