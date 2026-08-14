/**
 * NotificationBell — real-time notification UI component.
 *
 * Architecture:
 * - On mount: fetch the last 20 notifications via REST (GET /api/notifications)
 * - Open a persistent SSE stream (GET /api/notifications/stream) using fetch + ReadableStream
 *   because EventSource doesn't support custom headers in browsers.
 * - On 'connected' event: sync unread count from server
 * - On 'notification' event: prepend to list, increment badge, show toast for warning/error
 * - On disconnect: exponential-backoff reconnect (1s → 2s → 4s … max 30s)
 * - Click on notification: mark read + navigate to the relevant module
 *
 * Navigation map (entityType → page):
 *   order          → orders
 *   pos_transaction → pos
 *   inventory      → inventory
 *   purchase_order → procurement
 *   return         → returns
 *   payment        → payments
 *   exchange       → exchanges
 *   customer       → customers
 *   (null / unknown) → no navigation
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from '../lib/api.js';
import { useToast } from './Toast.js';

// Use the same base URL as the main API client
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)
  ? `${import.meta.env.VITE_API_URL as string}/api`
  : '/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Notification {
  id: number;
  eventType: string;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  createdAt: string;
}

interface NotificationBellProps {
  onNavigate?: (page: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** entityType → TanStack Query keys to invalidate when a notification arrives */
const ENTITY_QUERY_KEYS: Record<string, string[][]> = {
  order:          [['orders-list']],
  pos_transaction:[['pos-history']],
  inventory:      [['inventory'], ['inventory-low-stock']],
  purchase_order: [['purchase-orders']],
  return:         [['returns']],
  payment:        [['payments'], ['orders-list']],
  exchange:       [['exchanges']],
  customer:       [['customers']],
};

/** entityType → sidebar page name */
const ENTITY_PAGE: Record<string, string> = {
  order:          'orders',
  pos_transaction:'pos',
  inventory:      'inventory',
  purchase_order: 'procurement',
  return:         'returns',
  payment:        'payments',
  exchange:       'exchanges',
  customer:       'customers',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function severityIcon(s: string) {
  if (s === 'success') return '✅';
  if (s === 'warning') return '⚠️';
  if (s === 'error')   return '❌';
  return 'ℹ️';
}

function severityBorder(s: string) {
  if (s === 'success') return 'border-l-green-400';
  if (s === 'warning') return 'border-l-amber-400';
  if (s === 'error')   return 'border-l-red-400';
  return 'border-l-blue-400';
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NotificationBell({ onNavigate }: NotificationBellProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount]     = useState(0);
  const [open, setOpen]                   = useState(false);
  const [loading, setLoading]             = useState(false);

  const dropdownRef    = useRef<HTMLDivElement>(null);
  const abortRef       = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1_000);
  const mountedRef     = useRef(true);

  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // ── REST: fetch initial list ────────────────────────────────────────────────

  const fetchList = useCallback(async () => {
    const token = getAccessToken();
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/notifications?pageSize=50`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) {
        console.warn('[NotificationBell] fetchList failed:', res.status, res.statusText);
        return;
      }
      const data = await res.json() as { data: Notification[] };
      if (mountedRef.current) {
        const list = data.data ?? [];
        setNotifications(list);
        setUnreadCount(list.filter(n => !n.isRead).length);
      }
    } catch (err) {
      console.warn('[NotificationBell] fetchList error:', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // ── SSE: open stream and process events ────────────────────────────────────

  const openStream = useCallback(() => {
    const token = getAccessToken();
    if (!token || !mountedRef.current) return;

    // Cancel any previous stream
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const scheduleReconnect = () => {
      if (!mountedRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000);
        openStream();
      }, reconnectDelay.current);
    };

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/notifications/stream`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
          credentials: 'include',
          signal,
        });

        if (!res.ok || !res.body) { scheduleReconnect(); return; }

        // Successful connection — reset backoff
        reconnectDelay.current = 1_000;

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer    = '';
        let eventName = '';
        let dataLine  = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) { scheduleReconnect(); return; }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              dataLine = line.slice(6).trim();
            } else if (line === '' && dataLine) {
              // ── Dispatch complete event ──────────────────────────────────
              if (eventName === 'connected') {
                try {
                  const parsed = JSON.parse(dataLine) as { unreadCount: number };
                  if (mountedRef.current) {
                    setUnreadCount(parsed.unreadCount ?? 0);
                    // Re-fetch list to ensure we have the latest data after reconnect
                    fetchList();
                  }
                } catch { /* ignore */ }

              } else if (eventName === 'notification') {
                try {
                  const notif = JSON.parse(dataLine) as Notification;
                  if (mountedRef.current) {
                    setNotifications(prev => [notif, ...prev.slice(0, 29)]);
                    setUnreadCount(c => c + 1);

                    // Toast for warning / error
                    if (notif.severity === 'warning' || notif.severity === 'error') {
                      showToast(`${notif.title}: ${notif.body}`, notif.severity === 'error' ? 'error' : 'info');
                    }

                    // Invalidate relevant query caches
                    const keys = notif.entityType ? ENTITY_QUERY_KEYS[notif.entityType] : null;
                    if (keys) {
                      for (const key of keys) {
                        queryClient.invalidateQueries({ queryKey: key });
                      }
                    }
                  }
                } catch { /* ignore */ }
              }

              eventName = '';
              dataLine  = '';
            }
          }
        }
      } catch (err: unknown) {
        // AbortError = intentional close, don't reconnect
        if (err instanceof Error && err.name === 'AbortError') return;
        scheduleReconnect();
      }
    })();
  }, [fetchList, queryClient, showToast]);

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    // Fetch the initial list immediately on mount — don't wait for SSE connected event
    fetchList();
    openStream();
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [openStream, fetchList]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Mark read ───────────────────────────────────────────────────────────────

  const markRead = useCallback(async (id: number) => {
    const token = getAccessToken();
    if (!token) return;
    // Optimistic update
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    setUnreadCount(c => Math.max(0, c - 1));
    try {
      await fetch(`${API_BASE}/notifications/${id}/read`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
    } catch { /* ignore — optimistic update already applied */ }
  }, []);

  const markAllRead = useCallback(async () => {
    const token = getAccessToken();
    if (!token) return;
    // Optimistic update
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await fetch(`${API_BASE}/notifications/read-all`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
    } catch { /* ignore */ }
  }, []);

  // ── Click handler ───────────────────────────────────────────────────────────

  const handleClick = useCallback((notif: Notification) => {
    if (!notif.isRead) markRead(notif.id);
    const page = notif.entityType ? ENTITY_PAGE[notif.entityType] : null;
    if (page && onNavigate) onNavigate(page);
    setOpen(false);
  }, [markRead, onNavigate]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="relative" ref={dropdownRef}>

      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        title={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[520px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 flex flex-col overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</h3>
              {loading && (
                <span className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              )}
            </div>
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                  Mark all read
                </button>
              )}
              <button onClick={() => fetchList()} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" title="Refresh">
                ↻
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-600">
                <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <p className="text-sm">No notifications yet</p>
                <p className="text-xs mt-1 text-gray-300 dark:text-gray-700">
                  Notifications appear when you perform operations
                </p>
              </div>
            ) : (
              notifications.map(notif => {
                const targetPage = notif.entityType ? ENTITY_PAGE[notif.entityType] : null;
                return (
                  <button
                    key={notif.id}
                    onClick={() => handleClick(notif)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-50 dark:border-gray-800 border-l-4 ${severityBorder(notif.severity)} transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50 ${!notif.isRead ? 'bg-blue-50/40 dark:bg-blue-950/20' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-base flex-shrink-0 mt-0.5" aria-hidden="true">
                        {severityIcon(notif.severity)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`text-xs font-semibold truncate ${!notif.isRead ? 'text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300'}`}>
                            {notif.title}
                          </p>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0 whitespace-nowrap">
                            {timeAgo(notif.createdAt)}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                          {notif.body}
                        </p>
                        {targetPage && (
                          <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-1">
                            → Go to {targetPage.charAt(0).toUpperCase() + targetPage.slice(1)}
                          </p>
                        )}
                      </div>
                      {!notif.isRead && (
                        <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" aria-label="Unread" />
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 flex-shrink-0 text-center">
              <p className="text-[10px] text-gray-400 dark:text-gray-600">
                Showing last {notifications.length} notification{notifications.length !== 1 ? 's' : ''}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
