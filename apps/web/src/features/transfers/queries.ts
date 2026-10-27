import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReceiveTransferRequest, ResolveTransferRequest, TransferRequest } from '@bms/shared';
import { inventoryKeys } from '../inventory/queries.js';
import {
  cancelTransfer, createTransfer, dispatchTransfer, getTransfer, listTransfers, receiveTransfer, resolveTransfer, updateTransfer,
  type TransferParams,
} from './api.js';

/**
 * Query keys for transfer notes. Every key starts with `transferKeys.all`; a
 * step on a note refreshes the notes and the stock, which it moves.
 */
export const transferKeys = {
  all: ['transfers'] as const,
  list: (params: TransferParams) => [...transferKeys.all, 'list', params] as const,
  one: (id: number) => [...transferKeys.all, 'one', id] as const,
};

export function useTransfers(params: TransferParams) {
  return useQuery({ queryKey: transferKeys.list(params), queryFn: () => listTransfers(params), placeholderData: keepPreviousData });
}

export function useTransfer(id: number | null) {
  return useQuery({ queryKey: transferKeys.one(id ?? 0), queryFn: () => getTransfer(id!), enabled: id !== null });
}

function useTransferStep<T>(fn: (v: T) => ReturnType<typeof getTransfer>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: transferKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}

export const useCreateTransfer = () => useTransferStep((body: TransferRequest) => createTransfer(body));
export const useUpdateTransfer = () => useTransferStep(({ id, body }: { id: number; body: TransferRequest }) => updateTransfer(id, body));
export const useCancelTransfer = () => useTransferStep((id: number) => cancelTransfer(id));
export const useDispatchTransfer = () => useTransferStep((id: number) => dispatchTransfer(id));
export const useReceiveTransfer = () =>
  useTransferStep(({ id, body }: { id: number; body: ReceiveTransferRequest }) => receiveTransfer(id, body));
export const useResolveTransfer = () =>
  useTransferStep(({ id, body }: { id: number; body: ResolveTransferRequest }) => resolveTransfer(id, body));
