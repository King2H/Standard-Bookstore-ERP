import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateSupplierReturnRequest, SupplierReturnDetail, UpdateSupplierReturnRequest } from '@bms/shared';
import { inventoryKeys } from '../inventory/queries.js';
import { purchaseOrderKeys, supplierLedgerKeys } from '../procurement/queries.js';
import {
  cancelSupplierReturn, createSupplierReturn, getSupplierReturn, listSupplierReturns, sendSupplierReturn, updateSupplierReturn,
  type SupplierReturnParams,
} from './api.js';

/**
 * Query keys for returns to supplier. Every key starts with `returnKeys.all`;
 * a step refreshes the returns, the orders and ledger they credit, and the
 * stock that sending moves.
 */
export const returnKeys = {
  all: ['supplier-returns'] as const,
  list: (params: SupplierReturnParams) => [...returnKeys.all, 'list', params] as const,
  one: (id: number) => [...returnKeys.all, 'one', id] as const,
};

export function useSupplierReturns(params: SupplierReturnParams, enabled = true) {
  return useQuery({ queryKey: returnKeys.list(params), queryFn: () => listSupplierReturns(params), placeholderData: keepPreviousData, enabled });
}

export function useSupplierReturn(id: number | null) {
  return useQuery({ queryKey: returnKeys.one(id ?? 0), queryFn: () => getSupplierReturn(id!), enabled: id !== null });
}

function useReturnStep<T>(fn: (v: T) => Promise<SupplierReturnDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([returnKeys.all, purchaseOrderKeys.all, supplierLedgerKeys.all, inventoryKeys.all]
      .map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

/** Creates a return, or saves a draft's changes when `id` is given. */
export const useSaveSupplierReturn = (id: number | null) =>
  useReturnStep((body: CreateSupplierReturnRequest) =>
    id === null ? createSupplierReturn(body) : updateSupplierReturn(id, { notes: body.notes, lines: body.lines } satisfies UpdateSupplierReturnRequest));
export const useSendSupplierReturn = () => useReturnStep((id: number) => sendSupplierReturn(id));
export const useCancelSupplierReturn = () => useReturnStep(({ id, reason }: { id: number; reason: string }) => cancelSupplierReturn(id, reason));
