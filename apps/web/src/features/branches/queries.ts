import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createBranch, deleteBranch, listBranches, runBranchAction, type BranchAction, type BranchListParams } from './api.js';

/** Every key starts with `branchKeys.all`, so a change refreshes branch data and nothing else. */
export const branchKeys = {
  all: ['branches'] as const,
  list: (params: BranchListParams) => [...branchKeys.all, 'list', params] as const,
};

export function useBranches(params: BranchListParams) {
  return useQuery({ queryKey: branchKeys.list(params), queryFn: () => listBranches(params) });
}

/** The open branches to pick from: the API's largest page, which covers a chain of any realistic size. */
export function useOpenBranches() {
  return useBranches({ isActive: 'true', pageSize: 100 });
}

function useRefreshBranches() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: branchKeys.all });
}

export function useCreateBranch() {
  const refresh = useRefreshBranches();
  return useMutation({ mutationFn: createBranch, onSuccess: refresh });
}

export function useBranchAction(action: BranchAction) {
  const refresh = useRefreshBranches();
  return useMutation({ mutationFn: (id: number) => runBranchAction(id, action), onSuccess: refresh });
}

export function useDeleteBranch() {
  const refresh = useRefreshBranches();
  return useMutation({ mutationFn: deleteBranch, onSuccess: refresh });
}
