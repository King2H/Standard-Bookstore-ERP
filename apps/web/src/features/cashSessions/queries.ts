import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CashMovementRequest, CloseCashSessionRequest, OpenCashSessionRequest } from '@bms/shared';
import {
  addCashMovement, closeCashSession, getCashSession, getCurrentCashSession, listCashSessions, openCashSession, reviewCashSession,
  type CashSessionParams,
} from './api.js';

/** Query keys for cash sessions. Every key starts with `cashKeys.all`; any step refreshes them all. */
export const cashKeys = {
  all: ['cash-sessions'] as const,
  current: () => [...cashKeys.all, 'current'] as const,
  list: (params: CashSessionParams) => [...cashKeys.all, 'list', params] as const,
  one: (id: number) => [...cashKeys.all, 'one', id] as const,
};

export function useCurrentCashSession() {
  return useQuery({ queryKey: cashKeys.current(), queryFn: getCurrentCashSession });
}

export function useCashSessions(params: CashSessionParams) {
  return useQuery({ queryKey: cashKeys.list(params), queryFn: () => listCashSessions(params), placeholderData: keepPreviousData });
}

export function useCashSession(id: number | null) {
  return useQuery({ queryKey: cashKeys.one(id ?? 0), queryFn: () => getCashSession(id!), enabled: id !== null });
}

function useCashStep<T>(fn: (v: T) => ReturnType<typeof getCashSession>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: cashKeys.all }) });
}

export const useOpenCashSession = () => useCashStep((body: OpenCashSessionRequest) => openCashSession(body));
export const useAddCashMovement = () => useCashStep(({ id, body }: { id: number; body: CashMovementRequest }) => addCashMovement(id, body));
export const useCloseCashSession = () => useCashStep(({ id, body }: { id: number; body: CloseCashSessionRequest }) => closeCashSession(id, body));
export const useReviewCashSession = () => useCashStep(({ id, reason }: { id: number; reason: string }) => reviewCashSession(id, reason));
