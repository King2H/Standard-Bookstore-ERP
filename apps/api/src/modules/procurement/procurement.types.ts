import type { Money, PurchaseOrderStatus } from '@bms/shared';

export type { PurchaseOrderStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

export type PaymentTerms = 'cash' | 'credit';
export type FinancialStatus = 'unpaid' | 'partial' | 'paid';

export interface PurchaseOrderRecord {
  id: string;
  branchId: number;
  supplierId: number;
  supplierName: string;
  status: PurchaseOrderStatus;
  totalAmount: Money;
  currency: string;
  expectedDeliveryDate: string | null;
  notes: string | null;
  receivingBranchId: number;
  receivingLocationId: number | null;
  receivingLocationName: string | null;
  financialStatus: FinancialStatus;
  paymentTerms: PaymentTerms;
  createdBy: number;
  approvedBy: number | null;
  closedReason: string | null;
  closedBy: number | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  receivedValue: Money;
  amountPaid: Money;
  creditNotesTotal: Money;
  orderedQuantityTotal: number;
  receivedQuantityTotal: number;
  lineItems?: LineRecord[];
  receipts?: ReceiptRecord[];
  payments?: SupplierPaymentRecord[];
  creditNotes?: CreditNoteRecord[];
}

export interface LineRecord {
  id: string;
  poId: string;
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  formatId: number | null;
  editionId: number | null;
  quantity: number;
  unitCost: Money;
  receivedQuantity: number;
}

export interface ReceiptRecord {
  id: string;
  poId: string;
  locationId: number;
  locationName: string;
  receivedBy: number;
  receivedAt: Date;
  notes: string | null;
  items: ReceiptItemRecord[];
}

export interface ReceiptItemRecord {
  id: string;
  receiptId: string;
  poLineItemId: string;
  bookTitle: string;
  quantityReceived: number;
}

export interface SupplierPaymentRecord {
  id: string;
  poId: string;
  amount: Money;
  paymentMethod: string;
  source: 'manual' | 'auto_on_receipt';
  notes: string | null;
  createdBy: number;
  createdAt: Date;
}

export interface CreditNoteRecord {
  id: string;
  poId: string;
  supplierId: number;
  amount: Money;
  reason: string;
  createdBy: number;
  createdAt: Date;
}

export interface NewLine {
  bookId: number;
  formatId: number | null;
  editionId: number | null;
  quantity: number;
  unitCost: Money;
}

export interface NewPurchaseOrder {
  supplierId: number;
  branchId: number;
  receivingBranchId: number | null;
  receivingLocationId: number | null;
  expectedDeliveryDate: string | null;
  notes: string | null;
  paymentTerms: PaymentTerms;
  lineItems: NewLine[];
}

/** A draft's changes; undefined leaves a field as it is. */
export interface PurchaseOrderChanges {
  supplierId?: number;
  receivingBranchId?: number | null;
  receivingLocationId?: number | null;
  expectedDeliveryDate?: string | null;
  notes?: string | null;
  paymentTerms?: PaymentTerms;
  lineItems?: NewLine[];
}

export interface Receipt {
  locationId: number | null;
  items: Array<{ poLineItemId: number; quantityReceived: number }>;
  notes: string | null;
}

export interface PurchaseOrderFilter {
  /** The scoped branch: an order is listed in its ordering and its receiving branch. */
  branchId: number;
  status?: PurchaseOrderStatus;
  supplierId?: number;
  dateFrom?: string;
  dateTo?: string;
}

export type Paging = { page: number; pageSize: number };
