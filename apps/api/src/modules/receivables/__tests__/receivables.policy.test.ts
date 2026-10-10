import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  checkCanCollect,
  checkCanWriteOff,
  checkOpen,
  statusAfterPayment,
  statusForDueDate,
} from '../receivables.policy.js';
import type { ReceivableStatus } from '../receivables.types.js';

const owing = (status: ReceivableStatus, original: string, outstanding: string) => ({
  status,
  originalAmount: Money.of(original),
  outstandingAmount: Money.of(outstanding),
});

describe('checkOpen', () => {
  it('refuses a written-off receivable with its own code, and a paid one', () => {
    expect(() => checkOpen({ status: 'WrittenOff' })).toThrow(expect.objectContaining({ code: 'RECEIVABLE_WRITTEN_OFF', statusCode: 422 }));
    expect(() => checkOpen({ status: 'Settled' })).toThrow(expect.objectContaining({ code: 'RECEIVABLE_ALREADY_SETTLED' }));
    for (const status of ['Pending', 'PartiallyPaid', 'Overdue'] as const) expect(() => checkOpen({ status })).not.toThrow();
  });
});

describe('checkCanCollect', () => {
  it('accepts up to the exact amount owed, not a cent more', () => {
    const r = owing('Pending', '100.00', '40.10');
    expect(() => checkCanCollect(r, Money.of('40.10'))).not.toThrow();
    expect(() => checkCanCollect(r, Money.of('40.11'))).toThrow(expect.objectContaining({ code: 'EXCEEDS_OUTSTANDING' }));
    expect(() => checkCanCollect(r, Money.ZERO)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('checkCanWriteOff', () => {
  it('writes off everything still owed', () => {
    expect(checkCanWriteOff(owing('Overdue', '100', '35.5')).toFixed()).toBe('35.50');
    expect(() => checkCanWriteOff(owing('WrittenOff', '100', '0'))).toThrow(expect.objectContaining({ code: 'RECEIVABLE_WRITTEN_OFF' }));
  });
});

describe('statusAfterPayment', () => {
  const today = '2026-10-10';
  it('is Settled when nothing is left', () => {
    expect(statusAfterPayment({ dueDate: null }, Money.ZERO, false, today)).toBe('Settled');
    expect(statusAfterPayment({ dueDate: null }, Money.of(5), true, today)).toBe('Settled');
  });

  it('keeps a past-due debt Overdue after a part payment', () => {
    expect(statusAfterPayment({ dueDate: '2026-10-09' }, Money.of(5), false, today)).toBe('Overdue');
    expect(statusAfterPayment({ dueDate: '2026-10-10' }, Money.of(5), false, today)).toBe('PartiallyPaid');
  });
});

describe('statusForDueDate', () => {
  const today = '2026-10-10';
  it('makes a receivable current again when its due date moves to today or later, or is removed', () => {
    expect(statusForDueDate(owing('Overdue', '100', '100'), '2026-10-10', today)).toBe('Pending');
    expect(statusForDueDate(owing('Overdue', '100', '60'), null, today)).toBe('PartiallyPaid');
  });

  it('makes it Overdue when the new date has passed', () => {
    expect(statusForDueDate(owing('Pending', '100', '100'), '2026-10-09', today)).toBe('Overdue');
  });
});
