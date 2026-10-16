import type { z } from 'zod';
import type { BookListQuerySchema, BookListResponse, MessageResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The book endpoints (#21), typed with their @bms/shared contracts. */

/** `GET /books` filters, as they travel in the query string. */
export type BookListParams = Omit<z.input<typeof BookListQuerySchema>, 'page' | 'pageSize' | 'branchId' | 'locationId'> & {
  page?: number;
  pageSize?: number;
};

/** Lifecycle actions, each `POST /books/{id}/{action}`. */
export type BookAction = 'deactivate' | 'reactivate' | 'archive' | 'restore';

export const listBooks = (params: BookListParams) => api.get<BookListResponse>(`/books${toQuery(params)}`);

export const runBookAction = (id: number, action: BookAction) => api.post<MessageResponse>(`/books/${id}/${action}`);

export const deleteBook = (id: number) => api.delete<MessageResponse>(`/books/${id}`);
