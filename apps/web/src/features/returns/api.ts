import type { z } from 'zod';
import type {
  CreateReturnRequestSchema, PosTransaction, PosTransactionListResponse, Return, ReturnListResponse,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The return endpoints (#21), typed with their @bms/shared contracts. */

/** `GET /returns` paging; the branch is the session's: the API takes it from there. */
export type ReturnsParams = {
  page?: number;
  pageSize?: number;
};

export const listReturns = (params: ReturnsParams) => api.get<ReturnListResponse>(`/returns${toQuery(params)}`);

/** One return, with its lines and how its value went back. */
export const getReturn = (id: string) => api.get<Return>(`/returns/${id}`);

/** A return as the counter sends it: lines and quantities; the refund goes back the way the sale was paid. */
export type NewReturn = z.input<typeof CreateReturnRequestSchema>;

export const createReturn = (body: NewReturn) => api.post<Return>('/returns', body);

/**
 * The branch's sale with this number, with its lines, or an error when there
 * is none: the list finds it by number, the detail brings the lines.
 */
export async function findSale(transactionNumber: string): Promise<PosTransaction> {
  const found = await api.get<PosTransactionListResponse>(`/pos/transactions${toQuery({ transactionNumber, pageSize: 1 })}`);
  if (found.items.length === 0) throw new Error('Transaction not found');
  return api.get<PosTransaction>(`/pos/transactions/${found.items[0].id}`);
}
