import type { LocationStock, MovementType, StockLevel, StockMovement } from '@bms/shared';
import type { LocationStockRecord, StockLevelRecord, StockMovementRecord } from './inventory.types.js';

/** The columns inventory.repository selects for a stock level. */
export interface StockLevelRow {
  book_id: number;
  book_title: string;
  book_isbn: string;
  book_is_active: boolean;
  location_id: number;
  location_name: string;
  branch_id: number;
  quantity: number;
  reserved: number | string;
  reorder_point: number;
  version: number;
  updated_at: Date;
}

export interface StockMovementRow {
  id: string;
  book_id: number;
  book_title: string;
  location_id: number;
  location_name: string;
  qty_before: number;
  qty_after: number;
  delta: number;
  movement_type: string;
  reason_code: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  staff_id: number;
  staff_username: string;
  created_at: Date;
}

export function toStockLevelRecord(row: StockLevelRow): StockLevelRecord {
  return {
    bookId: row.book_id,
    bookTitle: row.book_title,
    bookIsbn: row.book_isbn,
    bookIsActive: row.book_is_active,
    locationId: row.location_id,
    locationName: row.location_name,
    branchId: row.branch_id,
    quantity: row.quantity,
    reserved: Number(row.reserved),
    reorderPoint: row.reorder_point,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export function toStockMovementRecord(row: StockMovementRow): StockMovementRecord {
  return {
    id: String(row.id),
    bookId: row.book_id,
    bookTitle: row.book_title,
    locationId: row.location_id,
    locationName: row.location_name,
    qtyBefore: row.qty_before,
    qtyAfter: row.qty_after,
    delta: row.delta,
    movementType: row.movement_type as MovementType,
    reasonCode: row.reason_code,
    referenceType: row.reference_type,
    referenceId: row.reference_id === null ? null : String(row.reference_id),
    notes: row.notes,
    staffId: row.staff_id,
    staffUsername: row.staff_username,
    createdAt: row.created_at,
  };
}

export function toStockLevelResponse(r: StockLevelRecord): StockLevel {
  return {
    bookId: r.bookId,
    bookTitle: r.bookTitle,
    bookIsbn: r.bookIsbn,
    bookIsActive: r.bookIsActive,
    locationId: r.locationId,
    locationName: r.locationName,
    branchId: r.branchId,
    quantity: r.quantity,
    reserved: r.reserved,
    // Not quantity - reserved: confirming an order already deducts its stock;
    // the reservation is bookkeeping, not a second hold.
    available: r.quantity,
    reorderPoint: r.reorderPoint,
    version: r.version,
    isLowStock: r.quantity <= r.reorderPoint,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toStockMovementResponse(r: StockMovementRecord): StockMovement {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

export function toLocationStockResponse(r: LocationStockRecord): LocationStock {
  return {
    ...r,
    available: r.quantity,
    sellable: Math.max(0, r.quantity - r.damaged),
  };
}
