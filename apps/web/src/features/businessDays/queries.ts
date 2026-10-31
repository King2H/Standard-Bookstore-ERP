import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closeBusinessDay, closeBusinessMonth, getBusinessDay, getBusinessMonth, getBusinessToday, listBusinessDays, listBusinessMonths,
  previewBusinessDay, previewBusinessMonth, reopenBusinessDay, reopenBusinessMonth,
} from './api.js';

/** Query keys for closed days and months. Every key starts with `businessDayKeys.all`; any close or reopen refreshes them all. */
export const businessDayKeys = {
  all: ['business-days'] as const,
  today: () => [...businessDayKeys.all, 'today'] as const,
  days: (month: string) => [...businessDayKeys.all, 'days', month] as const,
  day: (day: string) => [...businessDayKeys.all, 'day', day] as const,
  kept: (id: number) => [...businessDayKeys.all, 'kept', id] as const,
  months: (year: number) => [...businessDayKeys.all, 'months', year] as const,
  month: (month: string) => [...businessDayKeys.all, 'month', month] as const,
  keptMonth: (id: number) => [...businessDayKeys.all, 'kept-month', id] as const,
};

/** Checked every minute, so the banner appears when another staff member closes the day. */
export function useBusinessToday() {
  return useQuery({ queryKey: businessDayKeys.today(), queryFn: getBusinessToday, refetchInterval: 60_000 });
}

export function useBusinessDays(month: string | null) {
  return useQuery({ queryKey: businessDayKeys.days(month ?? ''), queryFn: () => listBusinessDays(month!), enabled: month !== null });
}

export function useDayPreview(day: string | null) {
  return useQuery({ queryKey: businessDayKeys.day(day ?? ''), queryFn: () => previewBusinessDay(day!), enabled: day !== null });
}

export function useBusinessDay(id: number | null) {
  return useQuery({ queryKey: businessDayKeys.kept(id ?? 0), queryFn: () => getBusinessDay(id!), enabled: id !== null });
}

export function useBusinessMonths(year: number | null) {
  return useQuery({ queryKey: businessDayKeys.months(year ?? 0), queryFn: () => listBusinessMonths(year!), enabled: year !== null });
}

export function useMonthPreview(month: string | null) {
  return useQuery({ queryKey: businessDayKeys.month(month ?? ''), queryFn: () => previewBusinessMonth(month!), enabled: month !== null });
}

export function useBusinessMonth(id: number | null) {
  return useQuery({ queryKey: businessDayKeys.keptMonth(id ?? 0), queryFn: () => getBusinessMonth(id!), enabled: id !== null });
}

function useCloseStep<T, R>(fn: (v: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: businessDayKeys.all }) });
}

export const useCloseDay = () => useCloseStep((day: string) => closeBusinessDay(day));
export const useReopenDay = () => useCloseStep(({ id, reason }: { id: number; reason: string }) => reopenBusinessDay(id, reason));
export const useCloseMonth = () => useCloseStep((month: string) => closeBusinessMonth(month));
export const useReopenMonth = () => useCloseStep(({ id, reason }: { id: number; reason: string }) => reopenBusinessMonth(id, reason));
