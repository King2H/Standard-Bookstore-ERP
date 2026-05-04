/**
 * Currency utilities — reads base_currency from system config.
 * Falls back to 'ETB' if config is unavailable.
 */

let _cachedCurrency: string | null = null;

/** Format a number with the given currency code. */
export function formatCurrency(amount: number, currency = 'ETB'): string {
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Short format (K/M suffix) with currency. */
export function formatCurrencyShort(amount: number, currency = 'ETB'): string {
  if (amount >= 1_000_000) return `${currency} ${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${currency} ${(amount / 1_000).toFixed(1)}K`;
  return `${currency} ${amount.toFixed(2)}`;
}

/** Get the cached currency symbol (set by useCurrency hook). */
export function getCachedCurrency(): string {
  return _cachedCurrency ?? 'ETB';
}

/** Set the cached currency (called by useCurrency hook on load). */
export function setCachedCurrency(currency: string): void {
  _cachedCurrency = currency;
}
