import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { getCashVarianceLimit, isCashSessionRequired } from '../config/config.service.js';
import * as policy from './cashSessions.policy.js';
import * as sessions from './cashSessions.repository.js';
import type {
  Actor,
  CashMovementInput,
  CashSessionFilter,
  CashSessionRecord,
  CashSessionView,
  CounterMoney,
  Paging,
} from './cashSessions.types.js';

/**
 * Use cases of cash sessions (A4, #171, owner decisions 1a–6a, 2026-10-28):
 * from the opening float to the count at close. One function each, owning
 * its transaction; each locks the session, so a movement and the close take
 * turns. recordCounterMoney is what the counter flows call, in their own
 * transaction.
 */

function found(s: CashSessionRecord | undefined): CashSessionRecord {
  if (s === undefined) throw new NotFoundError('Cash session');
  return s;
}

function audit(q: Queryable, actor: Actor, id: number, meta: Record<string, unknown>, action: 'CREATE' | 'UPDATE' = 'UPDATE') {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'cash_session',
    entityId: String(id),
    meta,
  });
}

const lock = async (q: Queryable, id: number) => found(await sessions.findSession(q, id, { forUpdate: true }));

// ── Reads (decision 5a) ───────────────────────────────────────────────────────

/** The session as the viewer may see it: the count is blind for its own staff member while open. */
async function view(q: Queryable, s: CashSessionRecord, viewer: Actor): Promise<CashSessionView> {
  const movements = await sessions.movements(q, s.id);
  if (policy.hidesExpected(s, viewer)) {
    return { ...s, expectedCash: null, totals: null, movements: movements.filter((m) => m.kind === 'pay_in' || m.kind === 'pay_out') };
  }
  const expectedCash = s.status === 'open' ? await sessions.expectedCash(q, s.id) : s.expectedCash;
  return { ...s, expectedCash, totals: await sessions.totals(q, s.id), movements };
}

export async function getById(viewer: Actor, id: number): Promise<CashSessionView> {
  const s = found(await sessions.findSession(kysely, id));
  policy.checkCanView(s, viewer);
  return view(kysely, s, viewer);
}

/** The viewer's open session in the session branch, and whether the branch needs one for cash. */
export async function current(viewer: Actor): Promise<{ required: boolean; session: CashSessionView | null }> {
  const [required, s] = await Promise.all([
    isCashSessionRequired(viewer.branchId),
    sessions.findOpenSession(kysely, viewer.staffId, viewer.branchId),
  ]);
  return { required, session: s ? await view(kysely, s, viewer) : null };
}

/** The branch's sessions; a staff member who may not see others' sees their own. */
export async function list(viewer: Actor, filter: CashSessionFilter, paging: Paging): Promise<{ items: CashSessionRecord[]; total: number }> {
  if (!policy.canSeeBranch(viewer.roles)) {
    if (filter.staffId !== undefined && filter.staffId !== viewer.staffId) return { items: [], total: 0 };
    filter = { ...filter, staffId: viewer.staffId };
  }
  return sessions.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Opening (decision 1a) ─────────────────────────────────────────────────────

export async function open(actor: Actor, openingFloat: Money): Promise<CashSessionView> {
  return withTransaction({}, async (tx) => {
    const already = () => new ConflictError('CASH_SESSION_ALREADY_OPEN', 'A cash session is already open; close it before opening another');
    if (await sessions.findOpenSession(tx, actor.staffId, actor.branchId)) throw already();
    let id: number;
    try {
      id = await sessions.insertSession(tx, { branchId: actor.branchId, staffId: actor.staffId, openingFloat });
    } catch (err) {
      // Two opens at once: the second meets the one-open-session index.
      if (isUniqueViolation(err)) throw already();
      throw err;
    }
    await audit(tx, actor, id, { action: 'open', openingFloat: openingFloat.toFixed(2) }, 'CREATE');
    return view(tx, found(await sessions.findSession(tx, id)), actor);
  });
}

// ── The counter's money (decision 2a) ─────────────────────────────────────────

/**
 * Records money a counter flow took or gave back, in the flow's transaction:
 * on the session that recorded what it reverses while that one is open (a
 * void hands back cash from the drawer that took it), else on the actor's
 * open session. With none, cash is refused where the branch requires a
 * session; otherwise nothing is recorded. Store credit, loyalty points and
 * credit notes never touch the drawer.
 */
export async function recordCounterMoney(q: Queryable, actor: Pick<Actor, 'staffId' | 'branchId'>, m: CounterMoney): Promise<void> {
  if (!policy.isCounterMethod(m.method) || !m.amount.greaterThan(0)) return;
  let sessionId = m.reverses ? await sessions.findOpenSessionOf(q, m.reverses.kind, m.reverses.sourceId) : undefined;
  sessionId ??= (await sessions.findOpenSession(q, actor.staffId, actor.branchId, { forUpdate: true }))?.id;
  if (sessionId === undefined) {
    if (policy.needsSession(m.method, await isCashSessionRequired(actor.branchId))) {
      throw new BusinessError('CASH_SESSION_REQUIRED', 'This branch takes cash only with an open cash session; open one first');
    }
    return;
  }
  await sessions.insertMovement(q, {
    sessionId,
    kind: m.kind,
    sourceId: m.sourceId,
    method: m.method,
    direction: m.direction,
    amount: m.amount,
    category: null,
    reason: null,
    staffId: actor.staffId,
  });
}

// ── Cash put in or taken out (decision 3a) ────────────────────────────────────

export async function addMovement(actor: Actor, id: number, input: CashMovementInput): Promise<CashSessionView> {
  return withTransaction({}, async (tx) => {
    const s = await lock(tx, id);
    policy.checkOwnSession(s, actor);
    policy.checkOpen(s.status);
    if (input.direction === 'out') policy.checkCanPayOut(await sessions.expectedCash(tx, id), input.amount);
    const kind = input.direction === 'in' ? 'pay_in' : 'pay_out';
    await sessions.insertMovement(tx, {
      sessionId: id,
      kind,
      sourceId: null,
      method: 'cash',
      direction: input.direction,
      amount: input.amount,
      category: input.category,
      reason: input.reason,
      staffId: actor.staffId,
    });
    await audit(tx, actor, id, { action: kind, category: input.category, amount: input.amount.toFixed(2), reason: input.reason });
    return view(tx, s, actor);
  });
}

// ── Closing (decision 4a) ─────────────────────────────────────────────────────

/**
 * The count, blind: expected, counted and variance are kept, and the session
 * is numbered Z-. Beyond the branch's limit it waits for a Manager or Admin,
 * who is told.
 */
export async function close(actor: Actor, id: number, counted: Money, note: string | null): Promise<CashSessionView> {
  return withTransaction({}, async (tx) => {
    const s = await lock(tx, id);
    policy.checkCanClose(s, actor);
    policy.checkOpen(s.status);
    const expected = await sessions.expectedCash(tx, id);
    const { variance, status } = policy.closeOutcome(expected, counted, Money.of(await getCashVarianceLimit(s.branchId)));
    const zNumber = await nextDailyNumber(tx, 'Z');
    await sessions.close(tx, id, { status, expected, counted, variance, note, closedBy: actor.staffId, zNumber });
    await audit(tx, actor, id, {
      action: 'close', zNumber, status, expectedCash: expected.toFixed(2), countedCash: counted.toFixed(2), variance: variance.toFixed(2), note,
    });
    if (status === 'pending_review') {
      await insertOutboxEvent(tx, 'cash_session.review_needed', {
        sessionId: id, zNumber, branchId: s.branchId, staffName: s.staffName, variance: variance.toNumber(),
      });
    }
    return view(tx, found(await sessions.findSession(tx, id)), actor);
  });
}

/** A Manager or Admin accepts a count beyond the limit, saying why; they may accept their own. */
export async function review(actor: Actor, id: number, reason: string): Promise<CashSessionView> {
  return withTransaction({}, async (tx) => {
    const s = await lock(tx, id);
    policy.checkPendingReview(s.status);
    await sessions.review(tx, id, { reviewedBy: actor.staffId, reason });
    await audit(tx, actor, id, { action: 'review', reason, variance: s.variance?.toFixed(2) ?? null });
    return view(tx, found(await sessions.findSession(tx, id)), actor);
  });
}
