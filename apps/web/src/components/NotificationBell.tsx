/**
 * NotificationBell — real-time notification UI component.
 *
 * - Connects to GET /api/notifications/stream (SSE)
 * - Shows bell icon with unread badge in the header
 * - Dropdown with last 20 notifications
 * - Mark as read / mark all read
 * - Auto-reconnects on disconnect
 * - Invalidates TanStack Query cache on notification receipt
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from '../lib/api.js';
import { useToast } from './Toast.js';

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

// Map entityType → query keys to invalidate
const ENTITY_QUERY_KEYS: Record<string, string[][]> = {
  order: [['orders']],
  pos_transaction: [['pos-transactions']],
  inventory: [['inventory'], ['inventory-low-stock']],
  purchase_order: [['purchase-orders']],
  return: [['returns']],
  payment: [['payments'], ['orders']],
  exchange: [['exchanges']],
  customer: [['customers']],
};

// Map entityType → page name for navigation
const ENTITY_PAGE_MAP: Record<string, string> = {
  order: 'orders',
  pos_transaction: 'pos',
  inventory: 'inventory',
  purchase_order: 'procurement',
  return: 'returns',
  payment: 'payments',
  exchange: 'exchanges',
  customer: 'customers',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function severityIcon(severity: string): string {
  switch (severity) {
    case 'success': return '✅';
    case 'warning': return '⚠️';
    case 'error': return '❌';
    default: return 'ℹ️';
  }
}

function severityBg(severity: string): string {
  switch (severity) {
    case 'success': return 'border-l-green-400';
    case 'warning': return 'border-l-amber-400';
    case 'error': return 'border-l-red-400';
    default: return 'border-l-blue-400';
  }
}

export default function NotificationBell({ onNavigate }: NotificationBellProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // ── Fetch initial notifications ───────────────────────────────────────────

  const fetchNotifications = useCallback(async () => {
    const token = getAccessToken();
    if (!token) return;
    try {
      const res = await fetch('/api/notifications?pageSize=20', {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  // ── SSE connection ────────────────────────────────────────────────────────

  const connect = useCallback(() => {
    const token = getAccessToken();
    if (!token) return;

    // EventSource doesn't support custom headers natively in browsers.
    // We pass the token as a query param (the server reads it from Authorization header OR query).
    // Since our server uses the Authorization header, we use a fetch-based approach instead.
    // For simplicity and broad compatibility, we use the standard EventSource with a token cookie
    // approach — but since we use Bearer tokens, we'll use a polyfill-style approach:
    // open the stream URL and handle it manually via fetch with ReadableStream.
    connectWithFetch(token);
  }, [fetchNotifications]);

  const connectWithFetch = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/notifications/stream', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        credentials: 'include',
      });

      if (!res.ok || !res.body) {
        scheduleReconnect();
        return;
      }

      // Reset reconnect delay on successful connection
      reconnectDelay.current = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              scheduleReconnect();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            let eventType = '';
            let dataLine = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataLine = line.slice(6).trim();
              } else if (line === '' && dataLine) {
                // Process complete event
                if (eventType === 'connected') {
                  try {
                    const parsed = JSON.parse(dataLine);
                    setUnreadCount(parsed.unreadCount ?? 0);
                    fetchNotifications();
                  } catch { /* ignore */ }
                } else if (eventType === 'notification') {
                  try {
                    const notif = JSON.parse(dataLine) as Notification;
                    setNotifications(prev => [notif, ...prev.slice(0, 19)]);
                    setUnreadCount(c => c + 1);

                    // Show toast for warning/error severity
                    if (notif.severity === 'warning' || notif.severity === 'error') {
                      showToast(notif.title + ': ' + notif.body, notif.severity === 'error' ? 'error' : 'info');
                    }

                    // Invalidate relevant TanStack Query keys
                    if (notif.entityType && ENTITY_QUERY_KEYS[notif.entityType]) {
                      for (const key of ENTITY_QUERY_KEYS[notif.entityType]) {
                        queryClient.invalidateQueries({ queryKey: key });
                      }
                    }
                  } catch { /* ignore */ }
                }
                eventType = '';
                dataLine = '';
              }
            }
          }
        } catch {
          scheduleReconnect();
        }
      };

      processStream();
    } catch {
      scheduleReconnect();
    }
  }, [fetchNotifications, queryClient, showToast]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
      connect();
    }, reconnectDelay.current);
  }, [connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

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

  // ── Mark as read ──────────────────────────────────────────────────────────

  const markRead = useCallback(async (id: number) => {
    const token = getAccessToken();
    if (!token) return;
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
      setUnreadCount(c => Math.max(0, c - 1));
    } catch { /* ignore */ }
  }, []);

  const markAllRead = useCallback(async () => {
    const token = getAccessToken();
    if (!token) return;
    try {
      await fetch('/api/notifications/read-all', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  }, []);

  // ── Handle notification click ─────────────────────────────────────────────

  const handleNotifClick = useCallback((notif: Notification) => {
    if (!notif.isRead) markRead(notif.id);
    if (notif.entityType && ENTITY_PAGE_MAP[notif.entityType] && onNavigate) {
      onNavigate(ENTITY_PAGE_MAP[notif.entityType]);
    }
    setOpen(false);
  }, [markRead, onNavigate]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        {/* Bell icon */}
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[480px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 flex flex-col overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-gray-400 dark:text-gray-600">
                <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <p className="text-sm">No notifications yet</p>
              </div>
            ) : (
              notifications.map(notif => (
                <button
                  key={notif.id}
                  onClick={() => handleNotifClick(notif)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 dark:border-gray-800 border-l-4 ${severityBg(notif.severity)} transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50 ${!notif.isRead ? 'bg-blue-50/40 dark:bg-blue-950/20' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="text-base flex-shrink-0 mt-0.5" aria-hidden="true">
                      {severityIcon(notif.severity)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className={`text-xs font-semibold truncate ${!notif.isRead ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                          {notif.title}
                        </p>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                          {timeAgo(notif.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                        {notif.body}
                      </p>
                    </div>
                    {!notif.isRead && (
                      <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" aria-label="Unread" />
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
