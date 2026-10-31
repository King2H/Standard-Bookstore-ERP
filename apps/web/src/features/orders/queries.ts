import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CancelOrderRequest } from '@bms/shared';
import { customerKeys } from '../customers/queries.js';
import { inventoryKeys } from '../inventory/queries.js';
import { paymentKeys } from '../payments/queries.js';
import { receivableKeys } from '../receivables/queries.js';
import {
  cancelOrder, confirmOrder, createOrder, deleteOrder, fulfillOrder, getOrder, listOrders, searchBooksForOrder,
  searchCustomersForOrder, updateOrder, type ConfirmOrder, type NewOrder, type OrdersParams,
} from './api.js';

/** Query keys for orders. Every key starts with `orderKeys.all`. */
export const orderKeys = {
  all: ['orders'] as const,
  list: (params: OrdersParams) => [...orderKeys.all, 'list', params] as const,
  detail: (id: string) => [...orderKeys.all, 'detail', id] as const,
  books: (q: string, locationId: number | null) => [...orderKeys.all, 'books', q, locationId] as const,
  customers: (q: string) => [...orderKeys.all, 'customers', q] as const,
};

export function useOrders(params: OrdersParams) {
  return useQuery({ queryKey: orderKeys.list(params), queryFn: () => listOrders(params), placeholderData: keepPreviousData });
}

export function useOrder(id: string, enabled = true) {
  return useQuery({ queryKey: orderKeys.detail(id), queryFn: () => getOrder(id), enabled });
}

/** Confirming, fulfilling and cancelling move stock (reserved, delivered, put back). */
function useOrderStep<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: orderKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}

export const useConfirmOrder = () => useOrderStep(({ id, body }: { id: string; body: ConfirmOrder }) => confirmOrder(id, body));
export const useFulfillOrder = () => useOrderStep(fulfillOrder);
/** Cancelling gives back what the order took (#167): payments, debts and store credit change too. */
export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CancelOrderRequest }) => cancelOrder(id, body),
    onSuccess: () => Promise.all([orderKeys.all, inventoryKeys.all, paymentKeys.all, receivableKeys.all, customerKeys.all]
      .map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: deleteOrder, onSuccess: () => qc.invalidateQueries({ queryKey: orderKeys.all }) });
}

/** A draft adds an order to the list; its confirmation (a separate step) moves the stock. */
/** Saves a draft's new contents (#174). */
export function useUpdateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: NewOrder }) => updateOrder(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: orderKeys.all }),
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: createOrder, onSuccess: () => qc.invalidateQueries({ queryKey: orderKeys.all }) });
}

export function useBooksForOrder(q: string, locationId: number | null) {
  return useQuery({ queryKey: orderKeys.books(q, locationId), queryFn: () => searchBooksForOrder(q, locationId), enabled: q.length > 1 });
}

export function useCustomersForOrder(q: string) {
  return useQuery({ queryKey: orderKeys.customers(q), queryFn: () => searchCustomersForOrder(q), enabled: q.length > 1 });
}
