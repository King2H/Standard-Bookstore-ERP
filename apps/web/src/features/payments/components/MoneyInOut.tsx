import { useState } from 'react';
import type { Money } from '@bms/shared';
import { paymentMethodLabel } from '../../../lib/paymentMethods.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMoneyInOut } from '../queries.js';
import { customerMoney } from '../rules.js';

const TYPE_LABELS: Record<string, string> = { ORDER: 'Order', POS: 'POS sale', RETURN: 'Return', EXCHANGE: 'Exchange' };
const INPUT = 'px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * Every customer payment in and refund out of a period, with what came in,
 * what went back and what is left: the rows behind the Dashboard's Cash
 * Collected, which opens it on its period (owner decision b; was: Payment
 * History, order payments only, which did not add up to the card).
 */
export function MoneyInOut({ initialRange }: { initialRange?: { dateFrom: string; dateTo: string } }) {
  const currency = useCurrency();
  const [range, setRange] = useState(initialRange ?? { dateFrom: today(), dateTo: today() });
  const wrongWay = range.dateFrom > range.dateTo;
  const { data, isLoading } = useMoneyInOut(range, !wrongWay);
  const money = customerMoney(data?.rows ?? []);
  const show = (m: Money) => `${currency} ${m.toFixed(2)}`;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3">
      <div className="flex gap-3 items-end flex-wrap">
        <label className="text-xs text-gray-500 dark:text-gray-400">From
          <input type="date" aria-label="From" value={range.dateFrom} onChange={(e) => setRange({ ...range, dateFrom: e.target.value })} className={`${INPUT} block mt-1`} />
        </label>
        <label className="text-xs text-gray-500 dark:text-gray-400">To
          <input type="date" aria-label="To" value={range.dateTo} onChange={(e) => setRange({ ...range, dateTo: e.target.value })} className={`${INPUT} block mt-1`} />
        </label>
        {wrongWay && <p role="alert" className="text-xs text-red-500 pb-2">The start date is after the end date</p>}
      </div>

      <div className="flex gap-2 flex-wrap text-sm font-medium">
        <span className="px-3 py-1.5 rounded-lg bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300">In {show(money.moneyIn)}</span>
        <span className="px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">Out {show(money.moneyOut)}</span>
        <span className="px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300">Net {show(money.net)}</span>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : money.rows.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No money in or out in this period</div>
        ) : (
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Date', 'In / Out', 'Type', 'Reference', 'Customer', 'Method', 'Amount', 'By'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {money.rows.map((r) => (
                <tr key={`${r.direction}:${r.referenceType}:${r.receiptNo}:${r.referenceNo}`}>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">{r.date}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r.direction === 'IN' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
                      {r.direction === 'IN' ? 'In' : 'Out'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300">{TYPE_LABELS[r.referenceType] ?? r.referenceType}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-700 dark:text-gray-300">{r.referenceNo}</td>
                  <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300">{r.party}</td>
                  <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300">{paymentMethodLabel(r.paymentMethod)}</td>
                  <td className={`px-4 py-2.5 font-medium whitespace-nowrap ${r.direction === 'IN' ? 'text-gray-900 dark:text-white' : 'text-red-600 dark:text-red-400'}`}>
                    {r.direction === 'OUT' ? '− ' : ''}{currency} {r.amount.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{r.user}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
