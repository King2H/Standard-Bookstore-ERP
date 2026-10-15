import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listBranchConfig, listSystemConfig, removeBranchOverride, setBranchConfig, setSystemConfig } from './api.js';

/** Every key starts with `settingsKeys.all`; a change refreshes only the settings it touched. */
export const settingsKeys = {
  all: ['config'] as const,
  system: () => [...settingsKeys.all, 'system'] as const,
  branch: (branchId: number) => [...settingsKeys.all, 'branch', branchId] as const,
};

export function useSystemConfig() {
  return useQuery({ queryKey: settingsKeys.system(), queryFn: listSystemConfig, staleTime: 30_000 });
}

export function useBranchConfig(branchId: number | null) {
  return useQuery({
    queryKey: settingsKeys.branch(branchId ?? 0),
    queryFn: () => listBranchConfig(branchId!),
    enabled: branchId !== null,
    staleTime: 30_000,
  });
}

export function useSetSystemConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => setSystemConfig(key, value),
    // A new system default shows through in every branch without an override.
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.all }),
  });
}

export function useBranchConfigChanges(branchId: number | null) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: settingsKeys.branch(branchId ?? 0) });
  return {
    set: useMutation({ mutationFn: ({ key, value }: { key: string; value: unknown }) => setBranchConfig(branchId!, key, value), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (key: string) => removeBranchOverride(branchId!, key), onSuccess: refresh }),
  };
}
