import type { PosTransaction, PosTransactionListResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The counter-sale endpoints (#21), typed with their @bms/shared contracts. */

/**
 * `GET /pos/transactions` filters, as they travel in the query string. The
 * branch is the session's: the API takes it from there.
 */
export type SalesParams = {
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
};

export const listSales = (params: SalesParams) => api.get<PosTransactionListResponse>(`/pos/transactions${toQuery(params)}`);

/** Same-day void, with payments going back the way they came. */
export const voidSale = (id: string) => api.post<PosTransaction>(`/pos/transactions/${id}/void`);
