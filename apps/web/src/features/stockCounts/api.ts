import type {
  EnterStockCountsRequest, OpenStockCountRequest, StockCountDetail, StockCountListResponse, StockCountStatus,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The stock count endpoints (#172), typed with their @bms/shared contracts. Counts are the session branch's. */

export type StockCountParams = { status?: StockCountStatus; page?: number; pageSize?: number };

export const listStockCounts = (params: StockCountParams) => api.get<StockCountListResponse>(`/stock-counts${toQuery(params)}`);

export const getStockCount = (id: number) => api.get<StockCountDetail>(`/stock-counts/${id}`);

export const openStockCount = (body: OpenStockCountRequest) => api.post<StockCountDetail>('/stock-counts', body);

/** Counted quantities; a book counted again replaces its count, a book found is added. */
export const enterStockCounts = (id: number, body: EnterStockCountsRequest) => api.post<StockCountDetail>(`/stock-counts/${id}/counts`, body);

export const submitStockCount = (id: number) => api.post<StockCountDetail>(`/stock-counts/${id}/submit`);

export const recountStockCount = (id: number, bookIds: number[]) => api.post<StockCountDetail>(`/stock-counts/${id}/recount`, { bookIds });

/** One adjustment per difference; books never counted stay unless counted as 0. */
export const postStockCount = (id: number, zeroBookIds: number[]) => api.post<StockCountDetail>(`/stock-counts/${id}/post`, { zeroBookIds });

export const cancelStockCount = (id: number, reason: string) => api.post<StockCountDetail>(`/stock-counts/${id}/cancel`, { reason });
