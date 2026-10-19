import { Money } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { paymentMethodPlainLabel } from '../../../lib/paymentMethods.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useCustomer } from '../../customers/queries.js';
import { useExchange } from '../queries.js';

/** An exchange as the customer takes it away: the books both ways and how the difference was settled. */
export function ExchangeSlip({ exchangeId, onClose }: { exchangeId: string; onClose: () => void }) {
  const currency = useCurrency();
  const { data: exc } = useExchange(exchangeId);
  const { data: customer } = useCustomer(exc?.customerId ?? null);
  const money = (n: number) => `${currency} ${Money.of(n).toFixed()}`;

  const books = (title: string, items: NonNullable<typeof exc>['incomingItems']) => (
    <div>
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-1">{title}</p>
      {(items ?? []).length === 0 ? <p className="text-sm text-gray-400">None</p> : (items ?? []).map((i) => (
        <div key={i.id} className="flex justify-between gap-4 text-sm">
          <span>{i.bookTitle} × {i.quantity}{i.condition === 'damaged' ? ' (damaged)' : ''}</span>
          <span className="tabular-nums">{Money.of(i.totalPrice).toFixed()}</span>
        </div>
      ))}
    </div>
  );

  return (
    <PrintSlip title={exc ? `Exchange ${exc.exchangeReference}` : 'Exchange'} onClose={onClose}>
      {!exc?.incomingItems ? <p className="text-sm text-gray-400">Loading...</p> : (
        <>
          <div className="space-y-1">
            <SlipRow label="Date">{new Date(exc.createdAt).toLocaleString()}</SlipRow>
            {customer && <SlipRow label="Customer">{customer.fullName} ({customer.customerCode})</SlipRow>}
          </div>
          {books('Brought in', exc.incomingItems)}
          {books('Taken', exc.outgoingItems)}
          <div className="space-y-1 border-t border-gray-200 dark:border-gray-700 pt-2">
            <SlipRow label="Brought in">{money(exc.totalIncomingValue)}</SlipRow>
            <SlipRow label="Taken">{money(exc.totalOutgoingValue)}</SlipRow>
            <SlipRow label="Difference"><span className="font-bold">{money(exc.netBalance)}</span> ({exc.settlementType.replace('_', ' ')})</SlipRow>
            {(exc.settlementEntries ?? []).map((s) => (
              <SlipRow key={s.id} label={s.entryType === 'cash_refund' ? 'Given back' : 'Paid'}>
                {money(s.amount)}{s.method ? ` · ${paymentMethodPlainLabel(s.method)}` : ''}
              </SlipRow>
            ))}
            {exc.outstandingAmount > 0 && <SlipRow label="On credit">{money(exc.outstandingAmount)}</SlipRow>}
            {exc.dueDate && <SlipRow label="Due date">{exc.dueDate}</SlipRow>}
          </div>
        </>
      )}
    </PrintSlip>
  );
}
