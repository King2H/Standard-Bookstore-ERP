import type { ReactNode } from 'react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { businessDayKeys } from '../features/businessDays/queries.js';
import { ToastProvider } from '../components/Toast.js';
import { ThemeProvider } from '../lib/theme.js';

export const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
  // Anything refused because the branch's day is closed (#175) shows the banner at once.
  mutationCache: new MutationCache({
    onError: (err) => {
      if ((err as { code?: string }).code === 'DAY_CLOSED') void queryClient.invalidateQueries({ queryKey: businessDayKeys.today() });
    },
  }),
});

/** Theme, server data and toasts, for the whole app. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
