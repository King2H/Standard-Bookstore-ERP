import type { AdjustmentReason, LifecycleStatus, MovementType } from '@bms/shared';

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

/** The locked row a manual change starts from. */
export interface LockedLevel {
  quantity: number;
  version: number;
  reorderPoint: number;
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
