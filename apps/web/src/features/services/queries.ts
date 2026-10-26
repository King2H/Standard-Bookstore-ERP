import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceJobStep, ServiceRequest } from '@bms/shared';
import {
  cancelBinding, createService, listServiceJobs, listServices, removeBranchFee, runServiceAction, setBranchFee, stepJob, updateService,
  type ServiceAction, type ServiceJobParams, type ServiceParams,
} from './api.js';

/** Query keys for services. Every key starts with `serviceKeys.all`, so a change refreshes every list. */
export const serviceKeys = {
  all: ['services'] as const,
  list: (params: ServiceParams) => [...serviceKeys.all, 'list', params] as const,
};

/** Query keys for the jobs board; a Ready notification refreshes them all. */
export const serviceJobKeys = {
  all: ['service-jobs'] as const,
  list: (params: ServiceJobParams) => [...serviceJobKeys.all, 'list', params] as const,
};

export function useServiceJobs(params: ServiceJobParams) {
  return useQuery({ queryKey: serviceJobKeys.list(params), queryFn: () => listServiceJobs(params), placeholderData: keepPreviousData });
}

/** Cancels a binding still Requested; `refresh` names the queries that carry it. */
export function useCancelBinding(refresh: ReadonlyArray<readonly unknown[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => cancelBinding(id, { reason }),
    onSuccess: () => Promise.all(refresh.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useServices(params: ServiceParams) {
  return useQuery({ queryKey: serviceKeys.list(params), queryFn: () => listServices(params), placeholderData: keepPreviousData });
}

function useServiceMutation<T>(fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: serviceKeys.all }) });
}

/** Creates a service, or changes the one named by `id`. */
export const useSaveService = () =>
  useServiceMutation(({ id, body }: { id: number | null; body: ServiceRequest }) => (id === null ? createService(body) : updateService(id, body)));

export const useServiceAction = () =>
  useServiceMutation(({ id, action }: { id: number; action: ServiceAction }) => runServiceAction(id, action));

/** Sets the session branch's fee, or removes it when `fee` is null. */
export const useBranchFee = () =>
  useServiceMutation(({ id, fee }: { id: number; fee: string | null }) => (fee === null ? removeBranchFee(id) : setBranchFee(id, { fee })));

/** Moves a sale's binding job one step on; `refresh` names the sale's queries, which carry the job. */
export function useJobStep(refresh: ReadonlyArray<readonly unknown[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, step }: { id: number; step: ServiceJobStep }) => stepJob(id, step),
    onSuccess: () => Promise.all(refresh.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
