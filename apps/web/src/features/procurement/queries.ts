import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePurchaseOrderRequest, ReceivePurchaseOrderRequest } from '@bms/shared';
import { inventoryKeys } from '../inventory/queries.js';
import {
  closePurchaseOrder, createPurchaseOrder, getPurchaseOrder, listPurchaseOrders, receivePurchaseOrder, runPurchaseOrderAction,
  updatePurchaseOrder, type PurchaseOrderAction, type PurchaseOrderListParams,
} from './api.js';

/**
 * Query keys for purchase orders. Every key starts with `purchaseOrderKeys.all`;
 * a change to an order also refreshes the supplier ledger, which is derived
 * from orders, receipts, payments and credit notes.
 */
export const purchaseOrderKeys = {
  all: ['purchase-orders'] as const,
  list: (params: PurchaseOrderListParams) => [...purchaseOrderKeys.all, 'list', params] as const,
  detail: (id: string) => [...purchaseOrderKeys.all, 'detail', id] as const,
};
export const supplierLedgerKeys = { all: ['supplier-ledger'] as const };

export function usePurchaseOrders(params: PurchaseOrderListParams) {
  return useQuery({ queryKey: purchaseOrderKeys.list(params), queryFn: () => listPurchaseOrders(params), placeholderData: keepPreviousData });
}

export function usePurchaseOrder(id: string) {
  return useQuery({ queryKey: purchaseOrderKeys.detail(id), queryFn: () => getPurchaseOrder(id) });
}

/** Refreshes everything an order's change shows in. */
export function useRefreshPurchaseOrders() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: purchaseOrderKeys.all }),
    qc.invalidateQueries({ queryKey: supplierLedgerKeys.all }),
  ]);
}

export function usePurchaseOrderStep(id: string) {
  const refresh = useRefreshPurchaseOrders();
  return useMutation({
    mutationFn: (step: { action: PurchaseOrderAction } | { action: 'close'; reason?: string }) =>
      step.action === 'close' ? closePurchaseOrder(id, step.reason) : runPurchaseOrderAction(id, step.action),
    onSuccess: refresh,
  });
}

/** Creates an order, or saves a draft's changes when `id` is given. */
export function useSavePurchaseOrder(id?: string) {
  const refresh = useRefreshPurchaseOrders();
  return useMutation({
    mutationFn: (body: CreatePurchaseOrderRequest) => (id ? updatePurchaseOrder(id, body) : createPurchaseOrder(body)),
    onSuccess: refresh,
  });
}

export function useReceivePurchaseOrder(id: string) {
  const refresh = useRefreshPurchaseOrders();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReceivePurchaseOrderRequest) => receivePurchaseOrder(id, body),
    // Received goods are stock: the inventory screens show them too.
    onSuccess: () => Promise.all([refresh(), qc.invalidateQueries({ queryKey: inventoryKeys.all })]),
  });
}
