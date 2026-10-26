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
  averageCost: Money;
  /** Damaged copies, kept apart from those for sale with their own value (#168). */
  damaged: number;
  damagedValue: Money;
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
  damaged: number;
  damagedValue: Money;
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

/**
 * Why stock leaves in a sale or an issue (#109): a sale is told apart from
 * shrinkage in stock history and reports, so every caller names its reason.
 */
export type IssueReason = 'sale' | 'loss' | 'correction';

/** Damaged copies coming in, at what each cost (#168); 0 when it is unknown or already counted as a loss. */
export interface DamagedReceipt extends StockChange {
  unitCost?: MoneyInput;
}

/** Damaged copies leaving by hand: written off, or back for sale after repair (#168). */
export interface DamagedChange {
  bookId: number;
  locationId: number;
  quantity: number;
  reason: string;
  /** The row's version when the change was asked; checked when given. */
  version?: number;
}

export interface StockIssue extends StockChange {
  reasonCode: IssueReason;
}

export interface StockReceipt extends StockChange {
  /**
   * What each unit cost: a purchase-order line, a cost named by hand, the
   * cost a unit left at when it comes back. Weighed into the average cost;
   * nothing is estimated (#163). More than zero unless `costMayBeZero`.
   */
  unitCost: MoneyInput;
  /**
   * The units truly cost nothing or have no cost: free copies on a purchase
   * order (owner decision 5a), copies coming back that left at cost 0.
   */
  costMayBeZero?: boolean;
  /** Copies arriving from another branch on a transfer note (#170); stock_in otherwise. */
  movementType?: 'stock_in' | 'transfer_in';
}

/** Copies leaving for another branch on a transfer note (#170). */
export interface StockSending {
  bookId: number;
  locationId: number;
  quantity: number;
  staffCtx: Actor;
  transferId: number;
  notes?: string;
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
