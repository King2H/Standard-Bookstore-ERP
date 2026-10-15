import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationListResponse, UnreadCountResponse } from '@bms/shared';
import { getUnreadCount, listNotifications, markAllNotificationsRead, markNotificationRead } from './api.js';

export const LIST_SIZE = 50;

/**
 * Keys carry the session branch: what one sees depends on it, so switching
 * branch reads the new branch's list and count (was: the old ones stayed).
 */
export const notificationKeys = {
  all: ['notifications'] as const,
  list: (branchId: number) => [...notificationKeys.all, 'list', branchId] as const,
  unread: (branchId: number) => [...notificationKeys.all, 'unread', branchId] as const,
};

export function useNotifications(branchId: number | undefined) {
  return useQuery({
    queryKey: notificationKeys.list(branchId ?? 0),
    queryFn: () => listNotifications(LIST_SIZE),
    enabled: branchId !== undefined,
  });
}

/** The server's count of every unread notification (was: the unread among the 50 loaded). */
export function useUnreadCount(branchId: number | undefined) {
  return useQuery({
    queryKey: notificationKeys.unread(branchId ?? 0),
    queryFn: getUnreadCount,
    enabled: branchId !== undefined,
  });
}

/** Marks read at once in the list and the count, then confirms with the server. */
export function useMarkRead(branchId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markNotificationRead,
    onMutate: (id: string) => {
      qc.setQueryData<NotificationListResponse>(notificationKeys.list(branchId), (old) =>
        old && { ...old, data: old.data.map((n) => (n.id === id ? { ...n, isRead: true } : n)) });
      qc.setQueryData<UnreadCountResponse>(notificationKeys.unread(branchId), (old) => old && { count: Math.max(0, old.count - 1) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useMarkAllRead(branchId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onMutate: () => {
      qc.setQueryData<NotificationListResponse>(notificationKeys.list(branchId), (old) =>
        old && { ...old, data: old.data.map((n) => ({ ...n, isRead: true })) });
      qc.setQueryData<UnreadCountResponse>(notificationKeys.unread(branchId), { count: 0 });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
