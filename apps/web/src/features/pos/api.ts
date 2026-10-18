import type { z } from 'zod';
import type {
  BookAvailabilityListResponse, CreatePosTransactionRequestSchema, CustomerListResponse, PosTransaction, PosTransactionListResponse,
} from '@bms/shared';
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

/** A counter sale, as the terminal sends it; the branch is the session's. */
export type NewSale = Omit<z.input<typeof CreatePosTransactionRequestSchema>, 'branchId'>;

export const createSale = (body: NewSale) => api.post<PosTransaction>('/pos/transactions', body);

/** Books matching what the cashier typed, with their stock at the till's location and the branch's price. */
export const searchBooksForSale = (q: string, locationId: number | null) =>
  api.get<BookAvailabilityListResponse>(`/books/with-availability${toQuery({ q, pageSize: 10, locationId })}`);

/** Active customers only: the API refuses a sale to an inactive or archived one. */
export const searchCustomersForSale = (q: string) =>
  api.get<CustomerListResponse>(`/customers${toQuery({ q, pageSize: 5, status: 'active' })}`);
