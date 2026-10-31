import type {
  BusinessDayDetail, BusinessDayListResponse, BusinessMonthDetail, BusinessMonthListResponse, DayPreview, MonthPreview, TodayStatus,
} from '@bms/shared';
import { api } from '../../lib/api.js';

/** The day and month close endpoints (#175), typed with their @bms/shared contracts. Days are the session branch's. */

/** Whether the session branch's day today is closed. */
export const getBusinessToday = () => api.get<TodayStatus>('/business-days/today');

export const listBusinessDays = (month: string) => api.get<BusinessDayListResponse>(`/business-days?month=${encodeURIComponent(month)}`);

/** A day's report so far, or as kept once closed, and what stops it closing. */
export const previewBusinessDay = (day: string) => api.get<DayPreview>(`/business-days/preview?day=${encodeURIComponent(day)}`);

export const getBusinessDay = (id: number) => api.get<BusinessDayDetail>(`/business-days/${id}`);

export const closeBusinessDay = (day: string) => api.post<BusinessDayDetail>('/business-days/close', { day });

export const reopenBusinessDay = (id: number, reason: string) => api.post<BusinessDayDetail>(`/business-days/${id}/reopen`, { reason });

export const listBusinessMonths = (year: number) => api.get<BusinessMonthListResponse>(`/business-months?year=${year}`);

/** Whether a month has ended, the days each branch still has to close, and its summary. */
export const previewBusinessMonth = (month: string) => api.get<MonthPreview>(`/business-months/preview?month=${encodeURIComponent(month)}`);

export const getBusinessMonth = (id: number) => api.get<BusinessMonthDetail>(`/business-months/${id}`);

export const closeBusinessMonth = (month: string) => api.post<BusinessMonthDetail>('/business-months/close', { month });

export const reopenBusinessMonth = (id: number, reason: string) => api.post<BusinessMonthDetail>(`/business-months/${id}/reopen`, { reason });
