import type {
  AdjustStockRequest, DamagedStockRequest, ReorderPointRequest, RevalueStockRequest, StockInRequest, StockLevel, StockLevelListResponse, StockMovementListResponse,
  StockOutRequest, TransferStockRequest, TransferStockResponse,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The inventory endpoints (#21), typed with their @bms/shared contracts. Stock is held per book and location. */

/** `GET /inventory` filters, as they travel in the query string. */
export type StockLevelParams = {
  q?: string;
  bookId?: number;
  locationId?: number;
  lowStockOnly?: boolean;
  is_active?: 'true' | 'false' | 'all';
  sortBy?: 'title' | 'updatedAt';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

/** `GET /inventory/history` filters. */
export type StockMovementParams = {
  movementType?: string;
  reasonCode?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
};

export const listStockLevels = (params: StockLevelParams) => api.get<StockLevelListResponse>(`/inventory${toQuery(params)}`);

/** Stock at or below its reorder point, in the session's branch. */
export const listLowStock = (params: { page?: number; pageSize?: number }) =>
  api.get<StockLevelListResponse>(`/inventory/low-stock${toQuery(params)}`);

export const listStockMovements = (params: StockMovementParams) =>
  api.get<StockMovementListResponse>(`/inventory/history${toQuery(params)}`);

export const setReorderPoint = (body: ReorderPointRequest) => api.put<StockLevel>('/inventory/reorder-point', body);

/** Sets the average cost of the copies on hand, with the reason; no copies move (#163). */
export const revalueStock = (body: RevalueStockRequest) => api.post<StockLevel>('/inventory/revalue', body);

/** Damaged copies written off, with the reason; their value leaves as a loss (#168). */
export const writeOffDamaged = (body: DamagedStockRequest) => api.post<StockLevel>('/inventory/damaged/write-off', body);

/** Damaged copies put back for sale after repair, at the cost they were kept at (#168). */
export const repairDamaged = (body: DamagedStockRequest) => api.post<StockLevel>('/inventory/damaged/repair', body);

/** Stock received by hand; purchase orders are received in Procurement. */
export const stockIn = (body: StockInRequest) => api.post<StockLevel>('/inventory/stock-in', body);

/** Stock removed by hand; sales take stock out through POS and orders. */
export const stockOut = (body: StockOutRequest) => api.post<StockLevel>('/inventory/stock-out', body);

/** One book's stock at one location, as it is now; null when it has none. */
export const findStockLevel = async (bookId: number, locationId: number) =>
  (await listStockLevels({ bookId, locationId, is_active: 'all', pageSize: 1 })).items[0] ?? null;

/** A correction by hand, with its reason: damage and loss remove stock, a return adds it, a correction goes either way. */
export const adjustStock = (body: AdjustStockRequest) => api.post<StockLevel>('/inventory/adjust', body);

/** Stock moved between two locations of the session's branch. */
export const transferStock = (body: TransferStockRequest) => api.post<TransferStockResponse>('/inventory/transfer', body);
