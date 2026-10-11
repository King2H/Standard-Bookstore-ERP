import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import { autoMatch, checkCancellable, checkEditable, checkMatch, checkUnmatch, normalizeAccountNumber, requireAccount } from '../bankAccount.policy.js';
import type { BankEntryRecord, StatementLineRecord } from '../bankAccount.types.js';

const entry = (over: Partial<BankEntryRecord> = {}): BankEntryRecord => ({
  id: '1', bankAccountId: 5, sourceType: 'pos_payment', sourceId: '9', amount: Money.of(100), direction: 'in',
  status: 'uncleared', notes: null, createdAt: new Date('2026-10-10T10:00:00Z'), madeOn: '2026-10-10', ...over,
});
const line = (over: Partial<StatementLineRecord> = {}): StatementLineRecord => ({
  id: '7', bankAccountId: 5, statementDate: '2026-10-11', amount: Money.of(100), direction: 'in', reference: null,
  description: null, entryId: null, matchedAt: null, importedAt: new Date(), ...over,
});
const newLine = { statementDate: '2026-10-11', amount: Money.of(100), direction: 'in' as const, reference: null, description: null };

describe('account numbers', () => {
  it('compares numbers without spaces, dashes or case', () => {
    expect(normalizeAccountNumber('1000-2000 30ab')).toBe('1000200030AB');
  });

  it('keeps number, IBAN and currency once money has moved', () => {
    expect(() => checkEditable(true, { accountNumber: '1' })).toThrow(expect.objectContaining({ code: 'BANK_ACCOUNT_IN_USE' }));
    expect(() => checkEditable(true, {})).not.toThrow();
    expect(() => checkEditable(false, { accountNumber: '1', currency: 'ETB' })).not.toThrow();
  });
});

describe('requireAccount', () => {
  it('needs an account for a bank payment only while the module is on', () => {
    expect(() => requireAccount(null, true)).toThrow();
    expect(requireAccount(null, false)).toBeNull();
    expect(requireAccount(3, true)).toBe(3);
  });
});

describe('autoMatch', () => {
  it('matches the only open movement of the same amount and direction within 3 days', () => {
    expect(autoMatch(newLine, [entry()])?.id).toBe('1');
    expect(autoMatch({ ...newLine, statementDate: '2026-10-13' }, [entry()])?.id).toBe('1');
  });

  it('leaves the line open when none fits, or more than one does', () => {
    expect(autoMatch({ ...newLine, statementDate: '2026-10-14' }, [entry()])).toBeUndefined();
    expect(autoMatch({ ...newLine, direction: 'out' }, [entry()])).toBeUndefined();
    expect(autoMatch(newLine, [entry({ amount: Money.of('100.01') })])).toBeUndefined();
    expect(autoMatch(newLine, [entry(), entry({ id: '2' })])).toBeUndefined();
    expect(autoMatch(newLine, [entry({ status: 'cleared' })])).toBeUndefined();
  });
});

describe('matching by hand', () => {
  it('pairs an open line with an open movement of the same account, amount and direction', () => {
    expect(() => checkMatch(line(), entry())).not.toThrow();
    expect(() => checkMatch(line({ entryId: '3' }), entry())).toThrow(expect.objectContaining({ code: 'ALREADY_CLEARED' }));
    expect(() => checkMatch(line(), entry({ status: 'cleared' }))).toThrow(expect.objectContaining({ code: 'ALREADY_CLEARED' }));
    expect(() => checkMatch(line(), entry({ amount: Money.of(99) }))).toThrow(expect.objectContaining({ code: 'MATCH_MISMATCH' }));
    expect(() => checkMatch(line(), entry({ bankAccountId: 6 }))).toThrow(expect.objectContaining({ code: 'MATCH_MISMATCH' }));
  });

  it('unmatches only a matched line', () => {
    expect(checkUnmatch(line({ entryId: '3' }))).toBe('3');
    expect(() => checkUnmatch(line())).toThrow(expect.objectContaining({ code: 'NOT_MATCHED' }));
  });
});

describe('checkCancellable', () => {
  it('lets an undone payment take back an open movement, not a matched one', () => {
    expect(() => checkCancellable(undefined)).not.toThrow();
    expect(() => checkCancellable(entry())).not.toThrow();
    expect(() => checkCancellable(entry({ status: 'cleared' }))).toThrow(expect.objectContaining({ code: 'BANK_ENTRY_CLEARED' }));
  });
});
