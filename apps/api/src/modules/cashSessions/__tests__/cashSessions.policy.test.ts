import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import {
  canSeeBranch,
  checkCanClose,
  checkCanPayOut,
  checkCanView,
  checkOpen,
  checkOwnSession,
  checkPendingReview,
  closeOutcome,
  expectedCash,
  hidesExpected,
  isCounterMethod,
  needsSession,
} from '../cashSessions.policy.js';
import { ROLE_PERMISSIONS } from '../../../lib/permissions.js';

const actor = (staffId: number, roles: string[], branchId = 1) => ({ staffId, role: roles[0], roles, branchId });
const cashier = actor(7, ['Sales']);
const other = actor(8, ['Sales']);
const manager = actor(9, ['Manager']);
const finance = actor(10, ['Finance_Officer']);
const session = (status: 'open' | 'pending_review' | 'closed' = 'open') => ({ staffId: 7, branchId: 1, status });
const m = (method: string, direction: 'in' | 'out', amount: string) => ({ method, direction, amount: Money.of(amount) });

describe('the drawer', () => {
  it('expects the float plus cash in less cash out; other methods are not in the drawer', () => {
    expect(expectedCash(Money.of('200'), []).toFixed(2)).toBe('200.00');
    expect(expectedCash(Money.of('200'), [m('cash', 'in', '45.50'), m('mobile', 'in', '99'), m('cash', 'out', '20.25'), m('bank', 'out', '5')]).toFixed(2))
      .toBe('225.25');
  });

  it('records the counter methods, not store credit, loyalty points or a credit note', () => {
    for (const method of ['cash', 'bank', 'mobile']) expect(isCounterMethod(method)).toBe(true);
    for (const method of ['store_credit', 'loyalty_points', 'credit_note']) expect(isCounterMethod(method)).toBe(false);
  });

  it('needs a session only for cash, and only where the branch requires one', () => {
    expect(needsSession('cash', true)).toBe(true);
    expect(needsSession('cash', false)).toBe(false);
    expect(needsSession('mobile', true)).toBe(false);
  });

  it('never takes out more than it holds', () => {
    expect(() => checkCanPayOut(Money.of('50'), Money.of('50'))).not.toThrow();
    expect(() => checkCanPayOut(Money.of('50'), Money.of('50.01'))).toThrow(expect.objectContaining({ code: 'CASH_SESSION_INSUFFICIENT_CASH' }));
  });
});

describe('closing (decision 4a)', () => {
  it('closes within the limit either way, and waits for review beyond it', () => {
    expect(closeOutcome(Money.of('100'), Money.of('100'), Money.of('50'))).toEqual({ variance: Money.of('0'), status: 'closed' });
    expect(closeOutcome(Money.of('100'), Money.of('50'), Money.of('50'))).toMatchObject({ status: 'closed' });
    expect(closeOutcome(Money.of('100'), Money.of('150'), Money.of('50'))).toMatchObject({ status: 'closed' });
    const short = closeOutcome(Money.of('100'), Money.of('49.99'), Money.of('50'));
    expect(short.status).toBe('pending_review');
    expect(short.variance.toFixed(2)).toBe('-50.01');
    expect(closeOutcome(Money.of('100'), Money.of('100.01'), Money.of('0'))).toMatchObject({ status: 'pending_review' });
  });

  it('works on an open session, and reviews a pending one', () => {
    expect(() => checkOpen('open')).not.toThrow();
    for (const s of ['pending_review', 'closed'] as const) {
      expect(() => checkOpen(s)).toThrow(expect.objectContaining({ code: 'CASH_SESSION_INVALID_STATUS' }));
    }
    expect(() => checkPendingReview('pending_review')).not.toThrow();
    for (const s of ['open', 'closed'] as const) {
      expect(() => checkPendingReview(s)).toThrow(expect.objectContaining({ code: 'CASH_SESSION_INVALID_STATUS' }));
    }
  });

  it("is closed by its own staff member, or by a Manager or Admin when they forgot", () => {
    expect(() => checkCanClose(session(), cashier)).not.toThrow();
    expect(() => checkCanClose(session(), manager)).not.toThrow();
    expect(() => checkCanClose(session(), other)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => checkCanClose(session(), finance)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('who sees and does what (decisions 3a, 5a)', () => {
  it("puts cash in or takes it out of one's own session only", () => {
    expect(() => checkOwnSession(session(), cashier)).not.toThrow();
    expect(() => checkOwnSession(session(), manager)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('shows the branch to Admin, Manager and Finance_Officer; a cashier their own', () => {
    expect(canSeeBranch(['Manager'])).toBe(true);
    expect(canSeeBranch(['Finance_Officer'])).toBe(true);
    expect(canSeeBranch(['Admin'])).toBe(true);
    expect(canSeeBranch(['Sales'])).toBe(false);
    expect(() => checkCanView(session(), cashier)).not.toThrow();
    expect(() => checkCanView(session(), finance)).not.toThrow();
    expect(() => checkCanView(session(), other)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('hides what is expected from its own staff member while open, unless they review sessions', () => {
    expect(hidesExpected(session('open'), cashier)).toBe(true);
    expect(hidesExpected(session('closed'), cashier)).toBe(false);
    expect(hidesExpected(session('pending_review'), cashier)).toBe(false);
    expect(hidesExpected(session('open'), finance)).toBe(false);
    expect(hidesExpected({ ...session('open'), staffId: 9 }, manager)).toBe(false);
  });

  it('lets Admin and Manager review a count over or short', () => {
    const reviewers = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.includes('REVIEW_CASH_SESSION')).map(([r]) => r);
    expect(reviewers.sort()).toEqual(['Admin', 'Manager']);
  });
});
