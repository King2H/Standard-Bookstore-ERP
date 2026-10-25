import { Money } from '@bms/shared';
import { useCurrency } from '../../../lib/useCurrency.js';
import { ServiceJobLine } from '../../services/components/ServiceJobLine.js';
import { posKeys, useSale } from '../queries.js';

/** A sale's books, each with its binding and job (#169), which whoever sells moves on. */
export function SaleLines({ saleId, canStep }: { saleId: string; canStep: boolean }) {
  const currency = useCurrency();
  const { data } = useSale(saleId);
  if (!data?.lineItems) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <ul className="space-y-1.5">
      {data.lineItems.map((li) => (
        <li key={li.id} className="text-xs">
          <div className="flex gap-3 text-gray-800 dark:text-gray-200">
            <span className="font-medium">{li.bookTitle}</span>
            <span className="text-gray-500">× {li.quantity}</span>
            <span className="tabular-nums">{currency} {Money.of(li.lineTotal).toFixed(2)}</span>
          </div>
          {li.service && (
            <div className="pl-4 mt-0.5">
              <ServiceJobLine line={li.service} canStep={canStep && data.status === 'completed'} refresh={[posKeys.all]} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
