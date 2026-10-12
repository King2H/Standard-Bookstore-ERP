import type { z } from 'zod';
import type {
  CreateSupplierRequest, MessageResponse, Supplier, SupplierListQuerySchema, SupplierListResponse,
  SupplierUsage, UpdateSupplierRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The supplier endpoints (#19), typed with their @bms/shared contracts. */

/** `GET /suppliers` filters, as they travel in the query string. */
export type SupplierListParams = Omit<z.input<typeof SupplierListQuerySchema>, 'page' | 'pageSize'> & {
  page?: number;
  pageSize?: number;
};

/** Lifecycle and moderation actions, each `POST /suppliers/{id}/{action}`. */
export type SupplierAction = 'deactivate' | 'activate' | 'archive' | 'restore' | 'blacklist';

export const listSuppliers = (params: SupplierListParams) =>
  api.get<SupplierListResponse>(`/suppliers${toQuery(params)}`);

export const getSupplier = (id: number) => api.get<Supplier>(`/suppliers/${id}`);

export const createSupplier = (body: CreateSupplierRequest) => api.post<Supplier>('/suppliers', body);

export const updateSupplier = (id: number, body: UpdateSupplierRequest) => api.put<Supplier>(`/suppliers/${id}`, body);

export const runSupplierAction = (id: number, action: SupplierAction) =>
  api.post<MessageResponse>(`/suppliers/${id}/${action}`);

export const deleteSupplier = (id: number) => api.delete<MessageResponse>(`/suppliers/${id}`);

export const getSupplierUsage = (id: number) => api.get<SupplierUsage>(`/suppliers/${id}/usage`);
