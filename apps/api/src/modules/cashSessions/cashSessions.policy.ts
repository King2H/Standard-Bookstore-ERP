import { Money } from '@bms/shared';
import { BusinessError, ForbiddenError } from '../../lib/errors.js';
import { getPermissionsForRoles } from '../../lib/permissions.js';
import type { Actor, CashSessionRecord, CashSessionStatus } from './cashSessions.types.js';

/**
 * Rules of cash sessions (A5), pure (#171, owner decisions 1a–6a,
 * 2026-10-28): what the drawer should hold, when a count waits for review,
 * and who sees and does what.
 */

type Session = Pick<CashSessionRecord, 'staffId' | 'status'>;
type Viewer = Pick<Actor, 'staffId' | 'roles'>;

// ── The drawer ────────────────────────────────────────────────────────────────

/** Taken at the counter and given back there; store credit, loyalty points and credit notes never touch the drawer. */
const COUNTER_METHODS = ['cash', 'bank', 'mobile'];

export const isCounterMethod = (method: string): boolean => COUNTER_METHODS.includes(method);

/** Where the branch requires it, cash at the counter needs an open session; other methods never do (decision 6a). */
export const needsSession = (method: string, required: boolean): boolean => required && method === 'cash';

/** Only cash is in the drawer: the float plus cash in less cash out. */
export function expectedCash(openingFloat: Money, movements: Array<{ method: string; direction: 'in' | 'out'; amount: Money }>): Money {
  return movements
    .filter((m) => m.method === 'cash')
    .reduce((sum, m) => (m.direction === 'in' ? sum.plus(m.amount) : sum.minus(m.amount)), openingFloat);
}

export function checkCanPayOut(expected: Money, amount: Money): void {
  if (amount.greaterThan(expected)) {
    throw new BusinessError('CASH_SESSION_INSUFFICIENT_CASH', `The drawer holds ${expected.toFixed(2)}; ${amount.toFixed(2)} cannot be taken out`);
  }
}

// ── Status (decision 4a) ──────────────────────────────────────────────────────

export function checkOpen(status: CashSessionStatus): void {
  if (status !== 'open') throw new BusinessError('CASH_SESSION_INVALID_STATUS', 'The cash session is closed');
}

export function checkPendingReview(status: CashSessionStatus): void {
  if (status !== 'pending_review') throw new BusinessError('CASH_SESSION_INVALID_STATUS', 'Only a count waiting for review can be accepted');
}

/** Counted less expected; beyond the limit, either way, the session waits for review. */
export function closeOutcome(expected: Money, counted: Money, limit: Money): { variance: Money; status: 'closed' | 'pending_review' } {
  const variance = counted.minus(expected);
  return { variance, status: variance.abs().greaterThan(limit) ? 'pending_review' : 'closed' };
}

// ── Who (decisions 3a, 5a) ────────────────────────────────────────────────────

const reviews = (roles: readonly string[]) => getPermissionsForRoles([...roles]).includes('REVIEW_CASH_SESSION');

/** Admin, Manager and Finance_Officer see every session of the branch; anyone else their own. */
export const canSeeBranch = (roles: readonly string[]): boolean => roles.some((r) => ['Admin', 'Manager', 'Finance_Officer'].includes(r));

export function checkCanView(session: Session, viewer: Viewer): void {
  if (session.staffId !== viewer.staffId && !canSeeBranch(viewer.roles)) {
    throw new ForbiddenError("Only a Manager, Admin or Finance_Officer sees another staff member's cash session");
  }
}

/** Cash is put in or taken out of one's own drawer only. */
export function checkOwnSession(session: Session, actor: Viewer): void {
  if (session.staffId !== actor.staffId) throw new ForbiddenError("Cash is put in or taken out of one's own cash session");
}

/** Its own staff member closes it; a Manager or Admin closes one left open. */
export function checkCanClose(session: Session, actor: Viewer): void {
  if (session.staffId !== actor.staffId && !reviews(actor.roles)) {
    throw new ForbiddenError("Only a Manager or Admin closes another staff member's cash session");
  }
}

/** The count is blind: its own staff member does not see what is expected while it is open, unless they review sessions. */
export const hidesExpected = (session: Session, viewer: Viewer): boolean =>
  session.status === 'open' && session.staffId === viewer.staffId && !canSeeBranch(viewer.roles);
