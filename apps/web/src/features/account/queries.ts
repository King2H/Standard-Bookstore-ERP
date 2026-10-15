import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { changeMyPassword, getMyProfile } from './api.js';

/** The profile page reads the same entry, so the account is fetched once. */
export const accountKeys = {
  me: ['my-profile'] as const,
};

export function useMyProfile() {
  return useQuery({ queryKey: accountKeys.me, queryFn: getMyProfile, staleTime: 60_000 });
}

export function useChangeMyPassword() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: changeMyPassword, onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.me }) });
}
