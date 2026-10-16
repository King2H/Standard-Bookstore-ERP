import type {
  ReorderPointRequest, StockLevel, StockLevelListResponse, StockMovementListResponse,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The inventory endpoints (#21), typed with their @bms/shared contracts. Stock is held per book and location. */

/** `GET /inventory` filters, as they travel in the query string. */
export type StockLevelParams = {
  q?: string;
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
