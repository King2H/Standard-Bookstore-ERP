import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customerKeys } from '../customers/queries.js';
import { changeDueDate, getReceivableSummary, listReceivables, writeOffReceivable, type ReceivablesParams } from './api.js';

/** Query keys for receivables. Every key starts with `receivableKeys.all`. */
export const receivableKeys = {
  all: ['receivables'] as const,
  list: (params: ReceivablesParams) => [...receivableKeys.all, 'list', params] as const,
  summary: (branchId: number) => [...receivableKeys.all, 'summary', branchId] as const,
};

export function useReceivables(params: ReceivablesParams) {
  return useQuery({ queryKey: receivableKeys.list(params), queryFn: () => listReceivables(params), placeholderData: keepPreviousData });
}

export function useReceivableSummary(branchId: number | null) {
  return useQuery({
    queryKey: receivableKeys.summary(branchId ?? 0), queryFn: () => getReceivableSummary(branchId!),
    enabled: branchId !== null, staleTime: 30_000,
  });
}

/** A write-off or a new due date changes the list, the totals and the customer's receivables. */
function useReceivableStep<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: receivableKeys.all }),
      qc.invalidateQueries({ queryKey: customerKeys.all }),
    ]),
  });
}

export const useWriteOff = () => useReceivableStep(({ id, reason }: { id: string; reason: string }) => writeOffReceivable(id, { reason }));
export const useChangeDueDate = () => useReceivableStep(({ id, dueDate }: { id: string; dueDate: string | null }) => changeDueDate(id, { dueDate }));
