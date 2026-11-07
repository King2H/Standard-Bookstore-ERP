import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportRequest } from '@bms/shared';
import { checkFile, importFile, type ImportKind } from './api.js';

/** Checking a file changes nothing; importing one changes every list it touches. */
export function useCheckFile(kind: ImportKind) {
  return useMutation({ mutationFn: (body: ImportRequest) => checkFile(kind, body) });
}

export function useImportFile(kind: ImportKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportRequest) => importFile(kind, body),
    onSuccess: () => client.invalidateQueries(),
  });
}
