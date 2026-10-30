import type { Money, SupplierReturnSource, SupplierReturnStatus } from '@bms/shared';

export type { SupplierReturnSource, SupplierReturnStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  roles: string[];
  branchId: number;
}

export interface SupplierReturnRecord {
  id: number;
  returnNumber: string;
  poId: string;
  branchId: number;
  supplierId: number;
  supplierName: string;
  status: SupplierReturnStatus;
  notes: string | null;
  createdBy: number;
  createdByName: string;
  createdAt: Date;
  sentBy: number | null;
  sentByName: string | null;
  sentAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  lineCount: number;
  totalQuantity: number;
  creditValue: Money;
  costValue: Money | null;
  creditNoteNumber: string | null;
}

export interface SupplierReturnLineRecord {
  id: number;
  poLineItemId: string;
  bookId: number;
  bookTitle: string;
  isbn: string | null;
  locationId: number;
  locationName: string;
  source: SupplierReturnSource;
  quantity: number;
  unitCredit: Money;
  unitCost: Money | null;
}

export type SupplierReturnView = SupplierReturnRecord & { lines: SupplierReturnLineRecord[] };

export interface ReturnLineInput {
  poLineItemId: number;
  locationId: number;
  source: SupplierReturnSource;
  quantity: number;
}

/** A line of the order, as a return needs it. */
export interface OrderLine {
  id: string;
  bookId: number;
  unitCost: Money;
  receivedQuantity: number;
}

export interface SupplierReturnFilter {
  branchId: number;
  status?: SupplierReturnStatus;
  poId?: number;
}

export interface Paging {
  page: number;
  pageSize: number;
}
