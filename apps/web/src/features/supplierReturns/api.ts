import type {
  CreateSupplierReturnRequest, SupplierReturnDetail, SupplierReturnListResponse, SupplierReturnStatus, UpdateSupplierReturnRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The return-to-supplier endpoints (#173), typed with their @bms/shared contracts. Returns are the session branch's. */

export type SupplierReturnParams = { status?: SupplierReturnStatus; poId?: number; page?: number; pageSize?: number };

export const listSupplierReturns = (params: SupplierReturnParams) => api.get<SupplierReturnListResponse>(`/supplier-returns${toQuery(params)}`);

export const getSupplierReturn = (id: number) => api.get<SupplierReturnDetail>(`/supplier-returns/${id}`);

export const createSupplierReturn = (body: CreateSupplierReturnRequest) => api.post<SupplierReturnDetail>('/supplier-returns', body);

/** A draft's lines replaced, its notes too. */
export const updateSupplierReturn = (id: number, body: UpdateSupplierReturnRequest) => api.put<SupplierReturnDetail>(`/supplier-returns/${id}`, body);

/** The copies leave at their cost; the order is credited at its price. */
export const sendSupplierReturn = (id: number) => api.post<SupplierReturnDetail>(`/supplier-returns/${id}/send`);

export const cancelSupplierReturn = (id: number, reason: string) => api.post<SupplierReturnDetail>(`/supplier-returns/${id}/cancel`, { reason });
