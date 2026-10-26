import type { Money, TransferEventKind, TransferOutcome, TransferStatus } from '@bms/shared';

export type { TransferEventKind, TransferOutcome, TransferStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  /** Every role held in the session branch (location limits look at all of them). */
  roles: string[];
  branchId: number;
}

export interface TransferRecord {
  id: number;
  transferNumber: string;
  fromBranchId: number;
  fromBranchName: string;
  fromLocationId: number;
  fromLocationName: string;
  toBranchId: number;
  toBranchName: string;
  status: TransferStatus;
  notes: string | null;
  createdBy: number;
  createdByName: string;
  createdAt: Date;
  dispatchedBy: number | null;
  dispatchedAt: Date | null;
  cancelledBy: number | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  totalQuantity: number;
  inTransitValue: Money;
}

/** What a line counts; the policy works from these. */
export interface LineCounts {
  quantity: number;
  /** Set on dispatch. */
  unitCost: Money | null;
  receivedQuantity: number;
  lostQuantity: number;
  damagedQuantity: number;
  returnedQuantity: number;
}

export interface TransferLineRecord extends LineCounts {
  id: number;
  transferId: number;
  bookId: number;
  bookTitle: string;
  isbn: string | null;
}

export interface TransferEventRecord {
  id: number;
  lineId: number;
  bookTitle: string;
  kind: TransferEventKind;
  quantity: number;
  locationId: number | null;
  locationName: string | null;
  reason: string | null;
  staffId: number;
  staffName: string;
  createdAt: Date;
}

export interface TransferView extends TransferRecord {
  lines: TransferLineRecord[];
  events: TransferEventRecord[];
}

export interface NewTransfer {
  fromLocationId: number;
  toBranchId: number;
  lines: Array<{ bookId: number; quantity: number }>;
  notes: string | null;
}

export interface TransferReceipt {
  locationId: number;
  items: Array<{ lineId: number; quantity: number }>;
  notes: string | null;
}

export interface TransferResolution {
  lineId: number;
  outcome: TransferOutcome;
  quantity: number;
  reason: string;
  locationId: number | null;
}

export interface TransferFilter {
  branchId: number;
  direction?: 'outgoing' | 'incoming';
  status?: TransferStatus;
}

export interface Paging {
  page: number;
  pageSize: number;
}
