import type { z } from 'zod';
import type {
  Book, BookAvailabilityListResponse, CreateExchangeRequestSchema, CustomerListResponse, Exchange, ExchangeListResponse,
  QuickRegisterBookRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The exchange endpoints (#21), typed with their @bms/shared contracts. */

/** `GET /exchanges` paging; the branch is the session's: the API takes it from there. */
export type ExchangesParams = {
  page?: number;
  pageSize?: number;
};

export const listExchanges = (params: ExchangesParams) => api.get<ExchangeListResponse>(`/exchanges${toQuery(params)}`);

/** One exchange, with its books both ways. */
export const getExchange = (id: string) => api.get<Exchange>(`/exchanges/${id}`);

/** A Quick Exchange as the counter sends it; the branch is the session's. */
export type NewExchange = z.input<typeof CreateExchangeRequestSchema>;

export const createExchange = (body: NewExchange) => api.post<Exchange>('/exchanges', body);

/** Same-day void, with a reason: stock and money go back both ways. */
export const voidExchange = (id: string, reason: string) => api.post<Exchange>(`/exchanges/${id}/void`, { reason });

/** Books matching what was typed, with their stock at the exchange's location and the branch's price. */
export const searchBooksForExchange = (q: string, locationId: number | null) =>
  api.get<BookAvailabilityListResponse>(`/books/with-availability${toQuery({ q, pageSize: 8, locationId })}`);

/** Active customers only: the API refuses an exchange for an inactive one. */
export const searchCustomersForExchange = (q: string) =>
  api.get<CustomerListResponse>(`/customers${toQuery({ q, pageSize: 5, status: 'active' })}`);

/** A catalog entry for a book brought in that the shop has never had; it adds no stock. */
export const quickRegisterBook = (body: QuickRegisterBookRequest) => api.post<Book>('/books/quick-register', body);
