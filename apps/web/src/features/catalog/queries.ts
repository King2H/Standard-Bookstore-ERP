import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateBookRequest, UpdateBookRequest } from '@bms/shared';
import { createBook, deleteBook, listBooks, runBookAction, updateBook, type BookAction, type BookListParams } from './api.js';

/** Query keys for books. Every key starts with `bookKeys.all`, so a change refreshes every book list. */
export const bookKeys = {
  all: ['books'] as const,
  lists: () => [...bookKeys.all, 'list'] as const,
  list: (params: BookListParams) => [...bookKeys.lists(), params] as const,
  activeCount: () => [...bookKeys.all, 'active-count'] as const,
};

export function useBooks(params: BookListParams) {
  return useQuery({ queryKey: bookKeys.list(params), queryFn: () => listBooks(params), placeholderData: keepPreviousData });
}

/** How many books are active, whatever the filters. */
export function useActiveBookCount() {
  return useQuery({
    queryKey: bookKeys.activeCount(),
    queryFn: async () => (await listBooks({ is_active: 'true', pageSize: 1 })).total,
    staleTime: 30_000,
  });
}

export function useRefreshBooks() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: bookKeys.all });
}

/** One mutation per action, so each shows its own progress. */
export function useBookAction(action: BookAction) {
  const refresh = useRefreshBooks();
  return useMutation({ mutationFn: (id: number) => runBookAction(id, action), onSuccess: refresh });
}

export interface BulkResult { done: number[]; refused: Array<{ id: number; message: string }> }

/** Runs `action` on each book in turn and reports which the API refused (was: refusals counted as done). */
export function useBulkBookAction(action: BookAction) {
  const refresh = useRefreshBooks();
  return useMutation({
    mutationFn: async (ids: number[]): Promise<BulkResult> => {
      const result: BulkResult = { done: [], refused: [] };
      for (const id of ids) {
        try {
          await runBookAction(id, action);
          result.done.push(id);
        } catch (e) {
          result.refused.push({ id, message: (e as Error).message });
        }
      }
      return result;
    },
    onSettled: refresh,
  });
}

export function useDeleteBook() {
  const refresh = useRefreshBooks();
  return useMutation({ mutationFn: (id: number) => deleteBook(id), onSuccess: refresh });
}

/** Creates a book, or changes the one with `id`. */
export function useSaveBook() {
  const refresh = useRefreshBooks();
  return useMutation({
    mutationFn: (save: { id: null; body: CreateBookRequest } | { id: number; body: UpdateBookRequest }) =>
      save.id === null ? createBook(save.body) : updateBook(save.id, save.body),
    onSuccess: refresh,
  });
}
