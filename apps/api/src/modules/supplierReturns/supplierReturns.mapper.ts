import type { SupplierReturn, SupplierReturnDetail } from '@bms/shared';
import { poNumber } from '../procurement/procurement.mapper.js';
import type { SupplierReturnRecord, SupplierReturnView } from './supplierReturns.types.js';

export function toSupplierReturn(r: SupplierReturnRecord): SupplierReturn {
  return {
    ...r,
    poNumber: poNumber(r.poId),
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    creditValue: r.creditValue.toNumber(),
    costValue: r.costValue?.toNumber() ?? null,
    gainLoss: r.costValue === null ? null : r.creditValue.minus(r.costValue).toNumber(),
  };
}

export function toSupplierReturnDetail(r: SupplierReturnView): SupplierReturnDetail {
  const { lines, ...head } = r;
  return {
    ...toSupplierReturn(head),
    lines: lines.map((l) => ({
      ...l,
      unitCredit: l.unitCredit.toNumber(),
      creditValue: l.unitCredit.times(l.quantity).round(2).toNumber(),
      unitCost: l.unitCost?.toNumber() ?? null,
      costValue: l.unitCost === null ? null : l.unitCost.times(l.quantity).round(2).toNumber(),
    })),
  };
}
