import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createLocation, deleteLocation, listLocations, renameLocation, setDefaultLocation } from './api.js';

/**
 * Keys start with `locationKeys.all`; a change refreshes that branch's
 * locations, wherever they are shown (stock screens pick from them too).
 */
export const locationKeys = {
  all: ['locations'] as const,
  branch: (branchId: number) => [...locationKeys.all, branchId] as const,
  everyInBranch: (branchId: number) => [...locationKeys.branch(branchId), 'all'] as const,
};

export function useLocations(branchId: number | null) {
  return useQuery({
    queryKey: locationKeys.branch(branchId ?? 0),
    queryFn: () => listLocations(branchId!),
    enabled: branchId !== null,
    staleTime: 30_000,
  });
}

/** Every location of a branch, also for staff limited to some: where a transfer may send stock. */
export function useEveryLocation(branchId: number | null) {
  return useQuery({
    queryKey: locationKeys.everyInBranch(branchId ?? 0),
    queryFn: () => listLocations(branchId!, { all: true }),
    enabled: branchId !== null,
    staleTime: 30_000,
  });
}

/** The changes to one branch's locations. */
export function useLocationChanges(branchId: number) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: locationKeys.branch(branchId) });
  return {
    create: useMutation({ mutationFn: (name: string) => createLocation(branchId, name), onSuccess: refresh }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: number; name: string }) => renameLocation(branchId, id, name), onSuccess: refresh }),
    setDefault: useMutation({ mutationFn: (id: number) => setDefaultLocation(branchId, id), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: number) => deleteLocation(branchId, id), onSuccess: refresh }),
  };
}
