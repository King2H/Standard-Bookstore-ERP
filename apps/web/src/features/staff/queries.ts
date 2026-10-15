import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateStaffRequest, SetStaffRolesRequest } from '@bms/shared';
import { listLocations } from '../locations/api.js';
import { locationKeys } from '../locations/queries.js';
import {
  createStaff, getStaffLocations, listStaff, resetPassword, runStaffAction, setAllBranches, setStaffLocations,
  setStaffRoles, type StaffAction, type StaffListParams,
} from './api.js';

/** Every key starts with `staffKeys.all`, so a change refreshes staff data and nothing else. */
export const staffKeys = {
  all: ['staff'] as const,
  list: (params: StaffListParams) => [...staffKeys.all, 'list', params] as const,
  locations: (id: number) => [...staffKeys.all, 'locations', id] as const,
};

export function useStaffList(params: StaffListParams) {
  return useQuery({ queryKey: staffKeys.list(params), queryFn: () => listStaff(params) });
}

export function useStaffLocations(id: number) {
  return useQuery({ queryKey: staffKeys.locations(id), queryFn: () => getStaffLocations(id), staleTime: 0 });
}

/** The locations of each branch, once per branch (the Locations page shares these entries). */
export function useLocationsOfBranches(branchIds: number[]) {
  const unique = [...new Set(branchIds)];
  return useQueries({
    queries: unique.map((branchId) => ({
      queryKey: locationKeys.branch(branchId),
      queryFn: () => listLocations(branchId),
      staleTime: 30_000,
    })),
    combine: (results) => ({
      items: results.flatMap((r) => r.data?.items ?? []),
      isLoading: results.some((r) => r.isLoading),
    }),
  });
}

function useRefreshStaff() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: staffKeys.all });
}

export function useCreateStaff() {
  const refresh = useRefreshStaff();
  return useMutation({ mutationFn: (body: CreateStaffRequest) => createStaff(body), onSuccess: refresh });
}

export function useStaffAction(action: StaffAction) {
  const refresh = useRefreshStaff();
  return useMutation({ mutationFn: (id: number) => runStaffAction(id, action), onSuccess: refresh });
}

export function useSetStaffRoles() {
  const refresh = useRefreshStaff();
  return useMutation({
    mutationFn: ({ id, roles }: { id: number; roles: SetStaffRolesRequest }) => setStaffRoles(id, roles),
    onSuccess: refresh,
  });
}

export function useSetAllBranches() {
  const refresh = useRefreshStaff();
  return useMutation({
    mutationFn: ({ id, isAllBranches }: { id: number; isAllBranches: boolean }) => setAllBranches(id, isAllBranches),
    onSuccess: refresh,
  });
}

export function useResetPassword() {
  const refresh = useRefreshStaff();
  return useMutation({
    mutationFn: ({ id, temporaryPassword }: { id: number; temporaryPassword: string }) => resetPassword(id, temporaryPassword),
    onSuccess: refresh,
  });
}

export function useSetStaffLocations() {
  const refresh = useRefreshStaff();
  return useMutation({
    mutationFn: ({ id, locationIds }: { id: number; locationIds: number[] }) => setStaffLocations(id, locationIds),
    onSuccess: refresh,
  });
}
