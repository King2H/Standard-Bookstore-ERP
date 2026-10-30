import { Money, type PurchaseOrder } from '@bms/shared';
import type {
  CreditNoteRecord,
  FinancialStatus,
  LineRecord,
  PaymentTerms,
  PurchaseOrderApprovalKind,
  PurchaseOrderRecord,
  PurchaseOrderStatus,
  PurchaseOrderView,
  ReceiptRecord,
  SupplierPaymentRecord,
  SupplierRefundRecord,
} from './procurement.types.js';

/** The columns procurement.repository selects for an order. */
export interface PurchaseOrderRow {
  id: string | number | bigint;
  branch_id: number;
  supplier_id: number;
  supplier_name: string;
  status: string;
  total_amount: string;
  currency: string;
  expected_delivery_date: string | null;
  notes: string | null;
  receiving_branch_id: number;
  receiving_location_id: number | null;
  receiving_location_name: string | null;
  financial_status: string;
  payment_terms: string;
  created_by: number;
  approved_by: number | null;
  approved_at: Date | null;
  approval_kind: string | null;
  approval_reason: string | null;
  closed_reason: string | null;
  closed_by: number | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  received_value: string;
  amount_paid: string;
  credit_notes_total: string;
  refunds_total: string;
  ordered_quantity_total: string | number;
  received_quantity_total: string | number;
}

// The database CHECK constraints limit status, financial_status, payment_terms and approval_kind to these values.
export function toPurchaseOrderRecord(row: PurchaseOrderRow): PurchaseOrderRecord {
  return {
    id: String(row.id),
    branchId: row.branch_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    status: row.status as PurchaseOrderStatus,
    totalAmount: Money.of(row.total_amount),
    currency: row.currency,
    expectedDeliveryDate: row.expected_delivery_date,
    notes: row.notes,
    receivingBranchId: row.receiving_branch_id,
    receivingLocationId: row.receiving_location_id,
    receivingLocationName: row.receiving_location_name,
    financialStatus: row.financial_status as FinancialStatus,
    paymentTerms: row.payment_terms as PaymentTerms,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    approvalKind: row.approval_kind as PurchaseOrderApprovalKind | null,
    approvalReason: row.approval_reason,
    closedReason: row.closed_reason,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    receivedValue: Money.of(row.received_value),
    amountPaid: Money.of(row.amount_paid),
    creditNotesTotal: Money.of(row.credit_notes_total),
    refundsTotal: Money.of(row.refunds_total),
    orderedQuantityTotal: Number(row.ordered_quantity_total),
    receivedQuantityTotal: Number(row.received_quantity_total),
  };
}

/**
 * What the order owes the supplier: what arrived, less paid and credited,
 * plus what the supplier paid back. Below zero the supplier holds our money:
 * an advance while goods are still due, or a refund due (#173, decision 4a).
 */
export function outstandingOf(po: Pick<PurchaseOrderRecord, 'receivedValue' | 'amountPaid' | 'creditNotesTotal' | 'refundsTotal'>): Money {
  return po.receivedValue.minus(po.amountPaid).minus(po.creditNotesTotal).plus(po.refundsTotal);
}

/**
 * The supplier owes money back once paid and credited beyond the whole
 * order, or beyond what arrived when nothing more is coming.
 */
export function refundDueOf(po: PurchaseOrderRecord): Money {
  const settled = po.amountPaid.plus(po.creditNotesTotal).minus(po.refundsTotal);
  const ceiling = po.status === 'closed' || po.status === 'cancelled' || po.status === 'received' ? po.receivedValue : po.totalAmount;
  const due = settled.minus(ceiling);
  return due.isNegative() ? Money.ZERO : due;
}

/** PO-000123: the number staff and suppliers see. */
export function poNumber(id: string | number): string {
  return `PO-${String(id).padStart(6, '0')}`;
}

/** Units still expected: none once the order is closed or cancelled. */
export function remainingOf(status: PurchaseOrderStatus, line: Pick<LineRecord, 'quantity' | 'receivedQuantity'>): number {
  if (status === 'closed' || status === 'cancelled') return 0;
  return line.quantity - line.receivedQuantity;
}

export function toPurchaseOrderResponse(po: PurchaseOrderView): PurchaseOrder {
  const { lineItems, receipts, payments, creditNotes, supplierRefunds, ...head } = po;
  return {
    ...head,
    poNumber: poNumber(po.id),
    totalAmount: po.totalAmount.toNumber(),
    approvedAt: po.approvedAt?.toISOString() ?? null,
    approvalThreshold: po.approvalThreshold.toNumber(),
    closedAt: po.closedAt?.toISOString() ?? null,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
    receivedValue: po.receivedValue.toNumber(),
    amountPaid: po.amountPaid.toNumber(),
    creditNotesTotal: po.creditNotesTotal.toNumber(),
    refundsTotal: po.refundsTotal.toNumber(),
    outstandingAmount: outstandingOf(po).toNumber(),
    refundDue: refundDueOf(po).toNumber(),
    ...(lineItems && {
      lineItems: lineItems.map((l) => ({ ...l, unitCost: l.unitCost.toNumber(), remaining: remainingOf(po.status, l) })),
    }),
    ...(receipts && { receipts: receipts.map((r: ReceiptRecord) => ({ ...r, receivedAt: r.receivedAt.toISOString() })) }),
    ...(payments && {
      payments: payments.map((p: SupplierPaymentRecord) => ({
        ...p,
        amount: p.amount.toNumber(),
        createdAt: p.createdAt.toISOString(),
        reversedAt: p.reversedAt?.toISOString() ?? null,
      })),
    }),
    ...(creditNotes && {
      creditNotes: creditNotes.map((c: CreditNoteRecord) => ({ ...c, amount: c.amount.toNumber(), createdAt: c.createdAt.toISOString() })),
    }),
    ...(supplierRefunds && {
      supplierRefunds: supplierRefunds.map((r: SupplierRefundRecord) => ({ ...r, amount: r.amount.toNumber(), createdAt: r.createdAt.toISOString() })),
    }),
  };
}
