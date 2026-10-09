import type { AdjustmentReason, LifecycleStatus, Money, MoneyInput, MovementType } from '@bms/shared';

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

/** One book at one location, with its book and location names. */
export interface StockLevelRecord {
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  bookIsActive: boolean;
  locationId: number;
  locationName: string;
  branchId: number;
  quantity: number;
  reserved: number;
  reorderPoint: number;
  version: number;
  updatedAt: Date;
}

export interface StockLevelFilter {
  branchId: number;
  locationId?: number;
  bookId?: number;
  lowStockOnly?: boolean;
  q?: string;
  /** Books' active flag; undefined means both. Ignored when `statuses` is set. */
  isActive?: boolean;
  statuses?: LifecycleStatus[];
  sortBy?: 'title' | 'updatedAt';
  sortDir?: 'asc' | 'desc';
}

export interface StockMovementRecord {
  id: string;
  bookId: number;
  bookTitle: string;
  locationId: number;
  locationName: string;
  qtyBefore: number;
  qtyAfter: number;
  delta: number;
  movementType: MovementType;
  reasonCode: string;
  referenceType: string | null;
  referenceId: string | null;
  notes: string | null;
  staffId: number;
  staffUsername: string;
  createdAt: Date;
}

export interface StockMovementFilter {
  branchId: number;
  bookId?: number;
  locationId?: number;
  reasonCode?: string;
  movementType?: MovementType;
  dateFrom?: string;
  dateTo?: string;
}

export interface LocationStockRecord {
  locationId: number;
  locationName: string;
  branchId: number;
  quantity: number;
  reserved: number;
  damaged: number;
}

/** The locked row a stock change starts from. */
export interface LockedLevel {
  quantity: number;
  version: number;
  reorderPoint: number;
  averageCost: Money;
}

/** One inventory_history row; `unitCost` values the units moved (null when unknown). */
export interface NewStockMovement {
  bookId: number;
  locationId: number;
  qtyBefore: number;
  qtyAfter: number;
  movementType: MovementType;
  reasonCode: string;
  referenceType: string | null;
  referenceId: number | string | null;
  notes: string | null;
  staffId: number;
  unitCost: Money | null;
}

export interface BookAvailabilityRecord {
  bookId: number;
  locationId: number;
  locationName: string;
  quantity: number;
  reserved: number;
}

/**
 * A stock movement booked by another module (a sale, a receipt, a return)
 * inside its own transaction. `staffCtx` is the staff member who made it.
 */
export interface StockChange {
  bookId: number;
  locationId: number;
  quantity: number;
  staffCtx: Actor;
  reasonCode?: string;
  referenceType?: string;
  referenceId?: number | string;
  notes?: string;
}

export interface StockReceipt extends StockChange {
  /**
   * What each unit cost, when known (a purchase-order line, the cost a sold
   * unit left at). It moves the weighted average cost; a receipt without one
   * leaves the average as it was. It must be more than zero.
   */
  unitCost?: MoneyInput;
}

export interface Adjustment {
  bookId: number;
  locationId: number;
  delta: number;
  reasonCode: AdjustmentReason;
  notes?: string;
  version: number;
  referenceType?: string;
  referenceId?: number;
}

/** What a stock change asks the notification system to tell people. */
export type StockAlert = 'inventory.low_stock' | 'inventory.out_of_stock';

export type Paging = { page: number; pageSize: number };
export type Paged<T> = { items: T[]; total: number; page: number; totalPages: number };
