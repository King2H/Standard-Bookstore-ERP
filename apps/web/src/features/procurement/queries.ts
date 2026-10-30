import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePurchaseOrderRequest, CreateSupplierCreditNoteRequest, CreateSupplierPaymentRequest, CreateSupplierRefundRequest, ReceivePurchaseOrderRequest,
} from '@bms/shared';
import { inventoryKeys } from '../inventory/queries.js';
import {
  approvePurchaseOrder, closePurchaseOrder, createPurchaseOrder, getPurchaseOrder, getSupplierLedger, listPurchaseOrders, receivePurchaseOrder,
  recordSupplierCreditNote, recordSupplierPayment, recordSupplierRefund, reverseSupplierPayment, runPurchaseOrderAction, updatePurchaseOrder,
  type PurchaseOrderAction, type PurchaseOrderListParams, type SupplierLedgerParams,
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
export const supplierLedgerKeys = {
  all: ['supplier-ledger'] as const,
  ledger: (supplierId: number, params: SupplierLedgerParams) => [...supplierLedgerKeys.all, supplierId, params] as const,
};

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
    mutationFn: (step: { action: PurchaseOrderAction } | { action: 'approve' | 'close'; reason?: string }) =>
      step.action === 'close' ? closePurchaseOrder(id, step.reason)
        : step.action === 'approve' ? approvePurchaseOrder(id, step.reason)
          : runPurchaseOrderAction(id, step.action),
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

/**
 * The supplier's ledger. Derived from orders, receipts, payments and credit
 * notes, so it is read again every 30 seconds while open: activity recorded
 * elsewhere shows up without a reload.
 */
export function useSupplierLedger(supplierId: number, params: SupplierLedgerParams) {
  return useQuery({
    queryKey: supplierLedgerKeys.ledger(supplierId, params),
    queryFn: () => getSupplierLedger(supplierId, params),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Payments, their reversal, credit notes and the supplier's refunds on one order. */
export function useSupplierPayables(id: string) {
  const refresh = useRefreshPurchaseOrders();
  return {
    pay: useMutation({ mutationFn: (body: CreateSupplierPaymentRequest) => recordSupplierPayment(id, body), onSuccess: refresh }),
    reverse: useMutation({
      mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) => reverseSupplierPayment(id, paymentId, reason),
      onSuccess: refresh,
    }),
    credit: useMutation({ mutationFn: (body: CreateSupplierCreditNoteRequest) => recordSupplierCreditNote(id, body), onSuccess: refresh }),
    refund: useMutation({ mutationFn: (body: CreateSupplierRefundRequest) => recordSupplierRefund(id, body), onSuccess: refresh }),
  };
}
