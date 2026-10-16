import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createReference, deleteReference, listReference, runReferenceAction, updateReference,
  type ReferenceAction, type ReferenceKind, type ReferenceListParams,
} from './api.js';

/**
 * Query keys for reference data. Each kind's keys start with its name, the
 * key the book screens still use for their lists of it, so a change to an
 * author refreshes every list of authors, and nothing else.
 */
export const referenceKeys = {
  all: (kind: ReferenceKind) => [kind] as const,
  list: (kind: ReferenceKind, params: ReferenceListParams) => [kind, 'list', params] as const,
};

export function useReferenceList(kind: ReferenceKind, params: ReferenceListParams) {
  return useQuery({
    queryKey: referenceKeys.list(kind, params),
    queryFn: () => listReference(kind, params),
    placeholderData: keepPreviousData,
  });
}

function useRefresh(kind: ReferenceKind) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: referenceKeys.all(kind) });
}

/** Creates a record, or renames (and for a category, moves) the one with `id`. */
export function useSaveReference(kind: ReferenceKind) {
  const refresh = useRefresh(kind);
  return useMutation({
    mutationFn: ({ id, name, parentId }: { id: number | null; name: string; parentId?: number | null }) => {
      const body = kind === 'categories' ? { name, parentId: parentId ?? null } : { name };
      return id === null ? createReference(kind, body) : updateReference(kind, id, body);
    },
    onSuccess: refresh,
  });
}

/** One mutation per action, so each button shows its own progress. */
export function useReferenceAction(kind: ReferenceKind, action: ReferenceAction) {
  const refresh = useRefresh(kind);
  return useMutation({ mutationFn: (id: number) => runReferenceAction(kind, id, action), onSuccess: refresh });
}

export function useDeleteReference(kind: ReferenceKind) {
  const refresh = useRefresh(kind);
  return useMutation({ mutationFn: (id: number) => deleteReference(kind, id), onSuccess: refresh });
}
