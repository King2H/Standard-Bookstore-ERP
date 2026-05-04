/**
 * useCurrency — fetches the effective currency from system config.
 * Returns 'ETB' as default while loading or on error.
 * Caches the result so all components share the same value.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { setCachedCurrency } from './currency.js';

export function useCurrency(): string {
  const { data } = useQuery<{ currency: string }>({
    queryKey: ['config-currency'],
    queryFn: () => api.get('/config/currency'),
    staleTime: 5 * 60_000, // 5 min — currency rarely changes
    retry: false,
  });
  const currency = data?.currency ?? 'ETB';
  setCachedCurrency(currency);
  return currency;
}
