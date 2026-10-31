import type { Money } from '@bms/shared';

export interface Actor {
  staffId: number;
  role: string;
  roles: string[];
  branchId: number;
}

export interface Paging {
  page: number;
  pageSize: number;
}

/** A special-order line with copies on order, as purchasers see it. */
export interface OpenLineRecord {
  orderLineId: string;
  orderId: string;
  orderNumber: string;
  orderedAt: Date;
  customerId: number | null;
  customerName: string | null;
  bookId: number;
  bookTitle: string;
  isbn: string | null;
  quantity: number;
  onOrder: number;
  linked: number;
  purchaseOrders: Array<{ poId: string; quantity: number; reserved: number }>;
}

/** An order line being linked or reserved for, locked, with its order. */
export interface LockedLine {
  id: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  branchId: number;
  /** The order's own location; null takes the branch's. */
  locationId: number | null;
  bookId: number;
  bookTitle: string;
  specialOrder: boolean;
  onOrder: number;
  /** Copies on purchase orders still to arrive. */
  linked: number;
}

/** A link with copies still to come, for an arrival. */
export interface OpenLink {
  id: number;
  orderLineId: string;
  orderId: string;
  orderNumber: string;
  branchId: number;
  locationId: number | null;
  outstanding: number;
}

export interface PoBookLine {
  id: string;
  quantity: number;
  receivedQuantity: number;
  unitCost: Money;
}
