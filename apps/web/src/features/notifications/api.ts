import type { MarkAllReadResponse, MarkReadResponse, NotificationListResponse, UnreadCountResponse } from '@bms/shared';
import { api } from '../../lib/api.js';

/** The signed-in staff member's notifications (#21), typed with their @bms/shared contracts. Ids are strings. */

/** The latest notifications, newest first. */
export const listNotifications = (pageSize: number) => api.get<NotificationListResponse>(`/notifications?pageSize=${pageSize}`);

export const getUnreadCount = () => api.get<UnreadCountResponse>('/notifications/unread-count');

export const markNotificationRead = (id: string) => api.put<MarkReadResponse>(`/notifications/${id}/read`);

export const markAllNotificationsRead = () => api.put<MarkAllReadResponse>('/notifications/read-all');
