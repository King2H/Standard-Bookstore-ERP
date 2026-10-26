import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Notification } from '@bms/shared';
import { apiUrl, authHeaders, getAccessToken } from '../../lib/api.js';
import { notificationKeys } from './queries.js';

/** entityType → TanStack Query keys to refresh when a notification about it arrives. */
const ENTITY_QUERY_KEYS: Record<string, string[][]> = {
  order:          [['orders-list']],
  pos_transaction:[['pos-history']],
  inventory:      [['inventory'], ['inventory-low-stock']],
  purchase_order: [['purchase-orders']],
  return:         [['returns']],
  payment:        [['payments'], ['orders-list']],
  exchange:       [['exchanges']],
  customer:       [['customers']],
  service_job:    [['service-jobs']],
};

/**
 * Listens to the live stream (GET /notifications/stream), read with fetch
 * because EventSource cannot send the access token. The stream belongs to the
 * session branch, so it is opened again when the branch changes (was: it kept
 * the previous branch's notifications). On connect, and on each notification,
 * the list and the unread count are read again; on a lost connection it
 * reconnects after 1 s, 2 s, 4 s … up to 30 s.
 */
export function useNotificationStream(branchId: number | undefined, onNotification: (n: Notification) => void) {
  const queryClient = useQueryClient();
  // The latest callback, read when an event arrives; a new one does not reopen the stream.
  const notify = useRef(onNotification);
  notify.current = onNotification;

  useEffect(() => {
    if (branchId === undefined) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1_000;
    const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });

    const scheduleReconnect = () => {
      if (stopped) return;
      reconnectTimer = setTimeout(() => {
        delay = Math.min(delay * 2, 30_000);
        void open();
      }, delay);
    };

    const dispatch = (event: string, data: string) => {
      if (event === 'connected') {
        refresh();
      } else if (event === 'notification') {
        let notif: Notification;
        try { notif = JSON.parse(data) as Notification; } catch { return; }
        refresh();
        notify.current(notif);
        for (const key of (notif.entityType && ENTITY_QUERY_KEYS[notif.entityType]) || []) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
    };

    const open = async () => {
      if (stopped || !getAccessToken()) return;
      controller = new AbortController();
      try {
        const res = await fetch(apiUrl('/notifications/stream'), {
          headers: { ...authHeaders(), Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) { scheduleReconnect(); return; }
        delay = 1_000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let event = '';
        let data = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { scheduleReconnect(); return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6).trim();
            else if (line === '' && data) {
              dispatch(event, data);
              event = '';
              data = '';
            }
          }
        }
      } catch (err) {
        // An abort is the stream being closed on purpose.
        if (err instanceof Error && err.name === 'AbortError') return;
        scheduleReconnect();
      }
    };

    void open();
    return () => {
      stopped = true;
      controller?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [branchId, queryClient]);
}
