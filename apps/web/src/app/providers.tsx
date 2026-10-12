import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../components/Toast.js';
import { ThemeProvider } from '../lib/theme.js';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
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
