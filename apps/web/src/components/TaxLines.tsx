import { Money } from '@bms/shared';
import { useShopIdentity } from '../features/settings/queries.js';

/** A rate kept as a fraction (0.15, 0.075) as a percentage to print: "15%", "7.5%". */
export function ratePercent(rate: number | string): string {
  return `${Number(Money.of(rate).times(100).toFixed(2))}%`;
}

/**
 * Under a receipt's or slip's total (#247, owner decision 2a; ADR-0010): the
 * tax the total includes, named as the shop names it, and the net before tax.
 * Prices include tax, so neither changes the total. A document made with tax
 * off (rate 0) shows nothing: the rate is the document's own, not today's.
 */
export function TaxLines({ rate, tax, total, currency, className = 'flex justify-between gap-4 text-sm text-gray-500 dark:text-gray-400' }: {
  rate: number | string;
  tax: number | string;
  total: number | string;
  currency: string;
  className?: string;
}) {
  const name = useShopIdentity().data?.taxName || 'Tax';
  if (!Money.of(rate).greaterThan(0)) return null;
  const label = `Includes ${name} ${ratePercent(rate)}`;
  return (
    <>
      <div className={className}><span>{label}</span><span className="tabular-nums">{currency} {Money.of(tax).toFixed(2)}</span></div>
      <div className={className}><span>Net before tax</span><span className="tabular-nums">{currency} {Money.of(total).minus(tax).toFixed(2)}</span></div>
    </>
  );
}
