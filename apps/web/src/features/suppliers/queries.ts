import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateSupplierRequest, UpdateSupplierRequest } from '@bms/shared';
import {
  createSupplier, deleteSupplier, getSupplier, listSuppliers, runSupplierAction, updateSupplier,
  type SupplierAction, type SupplierListParams,
} from './api.js';

/**
 * Query keys for supplier data. Every key starts with `supplierKeys.all`, so
 * a change refreshes the supplier lists and details, and nothing else.
 */
export const supplierKeys = {
  all: ['suppliers'] as const,
  lists: () => [...supplierKeys.all, 'list'] as const,
  list: (params: SupplierListParams) => [...supplierKeys.lists(), params] as const,
  detail: (id: number) => [...supplierKeys.all, 'detail', id] as const,
};

export function useSuppliers(params: SupplierListParams) {
  return useQuery({ queryKey: supplierKeys.list(params), queryFn: () => listSuppliers(params) });
}

export function useSupplier(id: number | null) {
  return useQuery({ queryKey: supplierKeys.detail(id ?? 0), queryFn: () => getSupplier(id!), enabled: id !== null });
}

function useRefreshSuppliers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: supplierKeys.all });
}

export function useCreateSupplier() {
  const refresh = useRefreshSuppliers();
  return useMutation({ mutationFn: (body: CreateSupplierRequest) => createSupplier(body), onSuccess: refresh });
}

export function useUpdateSupplier() {
  const refresh = useRefreshSuppliers();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateSupplierRequest }) => updateSupplier(id, body),
    onSuccess: refresh,
  });
}

/** One mutation per action, so each button shows its own progress. */
export function useSupplierAction(action: SupplierAction) {
  const refresh = useRefreshSuppliers();
  return useMutation({ mutationFn: (id: number) => runSupplierAction(id, action), onSuccess: refresh });
}

export function useDeleteSupplier() {
  const refresh = useRefreshSuppliers();
  return useMutation({ mutationFn: (id: number) => deleteSupplier(id), onSuccess: refresh });
}
