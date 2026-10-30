import type { Money, StockCountScope, StockCountStatus } from '@bms/shared';

export type { StockCountScope, StockCountStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  /** Every role held in the session branch. */
  roles: string[];
  branchId: number;
}

export interface StockCountRecord {
  id: number;
  countNumber: string;
  branchId: number;
  locationId: number;
  locationName: string;
  scope: StockCountScope;
  status: StockCountStatus;
  notes: string | null;
  createdBy: number;
  createdByName: string;
  createdAt: Date;
  submittedAt: Date | null;
  postedBy: number | null;
  postedByName: string | null;
  postedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  lineCount: number;
  countedLines: number;
}

export interface StockCountLineRecord {
  id: number;
  bookId: number;
  bookTitle: string;
  isbn: string | null;
  frozenQuantity: number;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  countedBy: number | null;
  countedByName: string | null;
  countedAt: Date | null;
  /** Every count of the book on this count, oldest first; the last is countedQuantity. */
  counts: number[];
  recountRequested: boolean;
  /** The location's average cost now; what a difference is worth until posted. */
  averageCost: Money;
  postedDelta: number | null;
  postedUnitCost: Money | null;
}

export interface StockCountView extends StockCountRecord {
  lines: StockCountLineRecord[];
  /** Whether frozen and expected quantities and the differences are hidden from the viewer (blind count). */
  blind: boolean;
}

export interface NewStockCount {
  locationId: number;
  scope: StockCountScope;
  bookIds: number[] | null;
  notes: string | null;
}

export interface StockCountFilter {
  branchId: number;
  status?: StockCountStatus;
  locationId?: number;
}

export interface Paging {
  page: number;
  pageSize: number;
}
