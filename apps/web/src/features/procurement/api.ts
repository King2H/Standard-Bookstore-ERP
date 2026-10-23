import type {
  BookAvailabilityListResponse, CatalogSearchResponse, CreatePurchaseOrderRequest, CreateSupplierCreditNoteRequest,
  CreateSupplierPaymentRequest, PurchaseOrder, PurchaseOrderListResponse, PurchaseOrderStatus, ReceivePurchaseOrderRequest,
  SupplierLedgerResponse, UpdatePurchaseOrderRequest,
} from '@bms/shared';
import { api, downloadFile, toQuery } from '../../lib/api.js';
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

/** The steps an order takes after it is written; approving and closing have their own calls. */
export type PurchaseOrderAction = 'submit' | 'order' | 'cancel';

export const listPurchaseOrders = (params: PurchaseOrderListParams) =>
  api.get<PurchaseOrderListResponse>(`/purchase-orders${toQuery(params)}`);

export const getPurchaseOrder = (id: string) => api.get<PurchaseOrder>(`/purchase-orders/${id}`);

export const runPurchaseOrderAction = (id: string, action: PurchaseOrderAction) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/${action}`);

/** Approving one's own order as the branch's only approver takes a reason (#164). */
export const approvePurchaseOrder = (id: string, reason?: string) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/approve`, reason ? { reason } : undefined);

/** A part-received order closes short with a reason; a fully received one needs none. */
export const closePurchaseOrder = (id: string, reason?: string) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/close`, reason ? { reason } : {});

/** Suppliers whose name matches, archived and inactive ones too: their orders stay on record. */
export const searchSuppliers = async (text: string) =>
  (await listSuppliers({ q: text || undefined, status: 'all', pageSize: 10 })).items.map((s) => ({ id: s.id, label: s.name }));

export const createPurchaseOrder = (body: CreatePurchaseOrderRequest) => api.post<PurchaseOrder>('/purchase-orders', body);

/** A draft's changes; the lines replace every line. */
export const updatePurchaseOrder = (id: string, body: UpdatePurchaseOrderRequest) => api.put<PurchaseOrder>(`/purchase-orders/${id}`, body);

/** Goods arriving at a location of the receiving branch. */
export const receivePurchaseOrder = (id: string, body: ReceivePurchaseOrderRequest) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/receive`, body);

/** Suppliers an order may go to: active and not blacklisted, found by typing (was: the first 200, loaded in full). */
export const searchSuppliersToBuyFrom = async (text: string) =>
  (await listSuppliers({ q: text || undefined, status: 'active', isBlacklisted: 'false', pageSize: 10 }))
    .items.map((s) => ({ id: s.id, label: s.name }));

/** A book to order; with a location, its stock there, so the buyer sees what is already on hand. */
export type BookToBuy = { id: number; title: string; isbn: string | null; isActive: boolean; available: number | null };

export async function searchBooksToBuy(text: string, at: { branchId: number | null; locationId: number | null }): Promise<BookToBuy[]> {
  if (at.locationId) {
    const res = await api.get<BookAvailabilityListResponse>(
      `/books/with-availability${toQuery({ q: text, pageSize: 10, branchId: at.branchId ?? undefined, locationId: at.locationId })}`,
    );
    return res.items.map((b) => ({ id: b.id, title: b.title, isbn: b.isbn, isActive: b.isActive, available: b.availability?.available ?? null }));
  }
  const res = await api.get<CatalogSearchResponse>(`/catalog/search${toQuery({ q: text })}`);
  return res.results.map((b) => ({ id: b.id, title: b.title, isbn: b.isbn, isActive: b.isActive, available: null }));
}

/** A payment to the supplier against an order; the ordering branch pays. */
export const recordSupplierPayment = (id: string, body: CreateSupplierPaymentRequest) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/payments`, body);

/** A payment recorded by mistake stops counting; it stays on record with the reason. */
export const reverseSupplierPayment = (id: string, paymentId: string, reason: string) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/payments/${paymentId}/reverse`, { reason });

/** The supplier's credit against an order: damaged goods, an overcharge, a negotiated price. */
export const recordSupplierCreditNote = (id: string, body: CreateSupplierCreditNoteRequest) =>
  api.post<PurchaseOrder>(`/purchase-orders/${id}/credit-notes`, body);

export type SupplierLedgerParams = { dateFrom?: string; dateTo?: string };

export const getSupplierLedger = (supplierId: number, params: SupplierLedgerParams) =>
  api.get<SupplierLedgerResponse>(`/suppliers/${supplierId}/ledger${toQuery(params)}`);

export const exportSupplierLedger = (supplierId: number, params: SupplierLedgerParams, filename: string) =>
  downloadFile(`/suppliers/${supplierId}/ledger/export${toQuery(params)}`, filename);
