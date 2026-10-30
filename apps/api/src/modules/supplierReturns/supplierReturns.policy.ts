import { Money } from '@bms/shared';
import { BusinessError } from '../../lib/errors.js';
import type { ReturnLineInput, SupplierReturnLineRecord, SupplierReturnStatus } from './supplierReturns.types.js';

/**
 * Rules of returns to supplier (A5), pure (#173, owner decisions 1a–6a,
 * 2026-10-30): which status allows what, how much can go back, and what a
 * return is worth.
 */

export function checkStatus(status: SupplierReturnStatus, allowed: SupplierReturnStatus[], action: string): void {
  if (!allowed.includes(status)) {
    throw new BusinessError('SUPPLIER_RETURN_INVALID_STATUS', `A return that is ${status} cannot be ${action}`);
  }
}

/**
 * Each line of the order sends back at most what arrived less what already
 * went back (decision 1a).
 */
export function checkWithinReceived(
  lines: ReturnLineInput[],
  orderLines: Map<string, { receivedQuantity: number }>,
  alreadySent: Map<string, number>,
): void {
  const asked = new Map<string, number>();
  for (const l of lines) asked.set(String(l.poLineItemId), (asked.get(String(l.poLineItemId)) ?? 0) + l.quantity);
  for (const [lineId, quantity] of asked) {
    const received = orderLines.get(lineId)?.receivedQuantity ?? 0;
    const sent = alreadySent.get(lineId) ?? 0;
    if (sent + quantity > received) {
      throw new BusinessError(
        'RETURN_EXCEEDS_RECEIVED',
        `Order line ${lineId}: ${quantity} to send back, but ${received} arrived and ${sent} already went back`,
        { poLineItemId: Number(lineId), requested: quantity, received, returned: sent },
      );
    }
  }
}

/** At the order's price: what the supplier credits. */
export const creditValue = (lines: Pick<SupplierReturnLineRecord, 'quantity' | 'unitCredit'>[]): Money =>
  Money.sum(lines.map((l) => l.unitCredit.times(l.quantity))).round(2);

/** What the copies cost when they left; null until every line has a cost. */
export function costValue(lines: Pick<SupplierReturnLineRecord, 'quantity' | 'unitCost'>[]): Money | null {
  if (lines.some((l) => l.unitCost === null)) return null;
  return Money.sum(lines.map((l) => l.unitCost!.times(l.quantity))).round(2);
}
