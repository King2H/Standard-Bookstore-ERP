import type { PurchaseOrder, PurchaseOrderListResponse, PurchaseOrderStatus } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';
import { listSuppliers } from '../suppliers/api.js';

/** The purchase-order endpoints (#21), typed with their @bms/shared contracts. */

/** `GET /purchase-orders` filters, as they travel in the query string. */
export type PurchaseOrderListParams = {
  status?: PurchaseOrderStatus;
  supplierId?: number;
  dateFrom?: string;
  dateTo?: string;
  /** Staff with access to all branches, from the Dashboard's drill-down. */
  branchId?: string;
  page?: number;
  pageSize?: number;
};

/** The steps an order takes after it is written; closing has its own call. */
export type PurchaseOrderAction = 'submit' | 'approve' | 'order' | 'cancel';

export const listPurchaseOrders = (params: PurchaseOrderListParams) =>
  api.get<PurchaseOrderListResponse>(`/purchase-orders${toQuery(params)}`);

export const getPurchaseOrder = (id: string) => api.get<PurchaseOrder>(`/purchase-orders/${id}`);

export const runPurchaseOrderAction = (id: string, action: PurchaseOrderAction) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/${action}`);

/** A part-received order closes short with a reason; a fully received one needs none. */
export const closePurchaseOrder = (id: string, reason?: string) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/close`, reason ? { reason } : {});

/** Suppliers whose name matches, archived and inactive ones too: their orders stay on record. */
export const searchSuppliers = async (text: string) =>
  (await listSuppliers({ q: text || undefined, status: 'all', pageSize: 10 })).items.map((s) => ({ id: s.id, label: s.name }));
