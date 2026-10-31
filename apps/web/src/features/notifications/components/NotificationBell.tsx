/**
 * NotificationBell: the signed-in staff member's notifications.
 *
 * - The list and the unread count come from the API, for the session branch
 *   (queries.ts); the count is the server's, not the unread among those loaded.
 * - The live stream (stream.ts) refreshes both when a notification arrives;
 *   warnings and errors also show as a toast.
 * - Clicking a notification marks it read and opens the page it is about.
 *
 * Navigation map (entityType → page):
 *   order → orders, pos_transaction → pos, inventory → inventory,
 *   purchase_order → procurement, return → returns, payment → payments,
 *   exchange → exchanges, customer → customers, service_job → binding-jobs,
 *   branch_transfer → inventory, on Incoming with the note open (#170);
 *   cash_session → cash-sessions, on the session (#171);
 *   anything else stays put.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { Notification } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from '../queries.js';
import { useNotificationStream } from '../stream.js';

interface NotificationBellProps {
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

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
  service_job:    'binding-jobs',
  branch_transfer:'inventory',
  cash_session:   'cash-sessions',
  stock_count:    'inventory',
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
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  const branchId = useMyProfile().data?.currentBranchId;
  const list = useNotifications(branchId);
  const unread = useUnreadCount(branchId);
  const notifications = list.data?.data ?? [];
  const unreadCount = unread.data?.count ?? 0;
  const loading = list.isFetching;
  const markReadMutation = useMarkRead(branchId ?? 0);
  const markAllMutation = useMarkAllRead(branchId ?? 0);

  useNotificationStream(branchId, (notif) => {
    if (notif.severity === 'warning' || notif.severity === 'error') {
      showToast(`${notif.title}: ${notif.body}`, notif.severity === 'error' ? 'error' : 'info');
    }
  });

  const fetchList = () => { void list.refetch(); void unread.refetch(); };

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

  const markAllRead = () => markAllMutation.mutate();

  const handleClick = useCallback((notif: Notification) => {
    if (!notif.isRead) markReadMutation.mutate(notif.id);
    const page = notif.entityType ? ENTITY_PAGE[notif.entityType] : null;
    // A transfer on its way is told to the branch receiving it.
    if (notif.entityType === 'branch_transfer' && onNavigate) onNavigate('inventory', { tab: 'incoming', transferId: notif.entityId ?? '' });
    else if (notif.entityType === 'stock_count' && onNavigate) onNavigate('inventory', { tab: 'counts', countId: notif.entityId ?? '' });
    else if (notif.entityType === 'cash_session' && onNavigate) onNavigate('cash-sessions', { sessionId: notif.entityId ?? '' });
    // An order opens itself, e.g. its special-order copies arrived (#174).
    else if (notif.entityType === 'order' && notif.entityId && onNavigate) onNavigate('orders', { orderId: notif.entityId });
    else if (page && onNavigate) onNavigate(page);
    setOpen(false);
  }, [markReadMutation, onNavigate]);

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
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
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
                      <span className="text-base shrink-0 mt-0.5" aria-hidden="true">
                        {severityIcon(notif.severity)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`text-xs font-semibold truncate ${!notif.isRead ? 'text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300'}`}>
                            {notif.title}
                          </p>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 whitespace-nowrap">
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
                        <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0 mt-1.5" aria-label="Unread" />
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 shrink-0 text-center">
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
