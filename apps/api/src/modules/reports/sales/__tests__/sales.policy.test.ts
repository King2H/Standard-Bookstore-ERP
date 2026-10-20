import { describe, it, expect } from 'vitest';
import { periodStart } from '../sales.policy.js';

describe('periodStart', () => {
  it('starts a week on its Monday, as date_trunc does', () => {
    expect(periodStart('2026-10-19', 'week')).toBe('2026-10-19'); // Monday
    expect(periodStart('2026-10-25', 'week')).toBe('2026-10-19'); // Sunday
    expect(periodStart('2026-11-01', 'week')).toBe('2026-10-26'); // across a month
    expect(periodStart('2027-01-01', 'week')).toBe('2026-12-28'); // across a year
  });

  it('starts a month on its first day, and a day on itself', () => {
    expect(periodStart('2026-10-31', 'month')).toBe('2026-10-01');
    expect(periodStart('2026-10-31', 'day')).toBe('2026-10-31');
  });
});
