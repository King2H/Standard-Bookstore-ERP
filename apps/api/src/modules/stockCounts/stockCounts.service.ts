import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BranchAccessError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import * as policy from './stockCounts.policy.js';
import * as counts from './stockCounts.repository.js';
import type { Actor, NewStockCount, Paging, StockCountFilter, StockCountRecord, StockCountView } from './stockCounts.types.js';

/**
 * Use cases of stock counts (A4, #172, owner decisions 1a–6a, 2026-10-30):
 * from opening a count to posting what it found. One function each, owning
 * its transaction; each locks the count, so two people acting on it take
 * turns.
 */

function found(c: StockCountRecord | undefined): StockCountRecord {
  if (c === undefined) throw new NotFoundError('Stock count');
  return c;
}

function audit(q: Queryable, actor: Actor, id: number, meta: Record<string, unknown>, action: 'CREATE' | 'UPDATE' = 'UPDATE') {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'stock_count',
    entityId: String(id),
    meta,
  });
}

/** The count, locked, of the actor's branch. */
async function lock(q: Queryable, actor: Actor, id: number): Promise<StockCountRecord> {
  const c = found(await counts.findCount(q, id, { forUpdate: true }));
  if (c.branchId !== actor.branchId) throw new BranchAccessError(c.branchId);
  return c;
}

async function view(q: Queryable, c: StockCountRecord, viewer: Actor): Promise<StockCountView> {
  return { ...c, lines: await counts.lines(q, c.id), blind: policy.isBlind(c.status, viewer.roles) };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(viewer: Actor, id: number): Promise<StockCountView> {
  return view(kysely, found(await counts.findCount(kysely, id)), viewer);
}

export function list(filter: StockCountFilter, paging: Paging): Promise<{ items: StockCountRecord[]; total: number }> {
  return counts.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Opening (decision 1a) ─────────────────────────────────────────────────────

/** A count of a location of the session branch, its expected quantities frozen; one open count per location. */
export async function open(actor: Actor, input: NewStockCount): Promise<StockCountView> {
  return withTransaction({}, async (tx) => {
    const branch = await counts.locationBranch(tx, input.locationId);
    if (branch === undefined) throw new NotFoundError('Location');
    if (branch !== actor.branchId) throw new BranchAccessError(branch);
    const already = () => new ConflictError('STOCK_COUNT_OPEN', 'A count of this location is still open; post or cancel it first');
    if (await counts.openCountAt(tx, input.locationId)) throw already();
    const missing = await counts.missingBooks(tx, input.bookIds ?? []);
    if (missing.length) throw new NotFoundError(`Book ${missing[0]}`);

    const countNumber = await nextDailyNumber(tx, 'CNT');
    let id: number;
    try {
      id = await counts.insertCount(tx, { countNumber, branchId: branch, locationId: input.locationId, scope: input.scope, notes: input.notes, createdBy: actor.staffId });
    } catch (err) {
      // Two opens at once: the second meets the one-open-count index.
      if (isUniqueViolation(err)) throw already();
      throw err;
    }
    if (input.scope === 'full') {
      await counts.insertLocationLines(tx, id, input.locationId);
    } else {
      for (const bookId of input.bookIds ?? []) {
        await counts.insertLine(tx, id, bookId, await inventoryService.onHand(tx, bookId, input.locationId));
      }
    }
    await audit(tx, actor, id, { action: 'open', countNumber, locationId: input.locationId, scope: input.scope, bookIds: input.bookIds }, 'CREATE');
    return view(tx, found(await counts.findCount(tx, id)), actor);
  });
}

// ── Counting (decisions 2a, 3a) ───────────────────────────────────────────────

/**
 * Each count is set against what the location holds at that moment, so a
 * sale during the count is never a shortage (2a). A book counted again
 * replaces its count; a book found that is not on the count is added.
 */
async function count(tx: Queryable, actor: Actor, c: StockCountRecord, items: Array<{ bookId: number; quantity: number }>): Promise<void> {
  const missing = await counts.missingBooks(tx, items.map((i) => i.bookId));
  if (missing.length) throw new NotFoundError(`Book ${missing[0]}`);
  // In book order, so two counts lock the stock rows in the same order.
  for (const item of [...items].sort((a, b) => a.bookId - b.bookId)) {
    const expected = await inventoryService.onHand(tx, item.bookId, c.locationId);
    const lineId = (await counts.findLine(tx, c.id, item.bookId)) ?? (await counts.insertLine(tx, c.id, item.bookId, expected));
    await counts.recordCount(tx, lineId, { quantity: item.quantity, expected, staffId: actor.staffId });
  }
}

export async function enterCounts(actor: Actor, id: number, items: Array<{ bookId: number; quantity: number }>): Promise<StockCountView> {
  return withTransaction({}, async (tx) => {
    const c = await lock(tx, actor, id);
    policy.checkStatus(c.status, ['counting'], 'counted');
    await count(tx, actor, c, items);
    await audit(tx, actor, id, { action: 'count', items });
    return view(tx, found(await counts.findCount(tx, id)), actor);
  });
}

/** The counters are done; the reviewers are told (decision 4a). */
export async function submit(actor: Actor, id: number): Promise<StockCountView> {
  return withTransaction({}, async (tx) => {
    const c = await lock(tx, actor, id);
    policy.checkStatus(c.status, ['counting'], 'submitted');
    await counts.setStatus(tx, id, 'submitted');
    await audit(tx, actor, id, { action: 'submit' });
    await insertOutboxEvent(tx, 'stock_count.submitted', {
      countId: id, countNumber: c.countNumber, branchId: c.branchId, locationName: c.locationName,
    });
    return view(tx, found(await counts.findCount(tx, id)), actor);
  });
}

// ── Review (decision 4a) ──────────────────────────────────────────────────────

/** An Admin or Manager sends books back to be counted again. */
export async function recount(actor: Actor, id: number, bookIds: number[]): Promise<StockCountView> {
  return withTransaction({}, async (tx) => {
    const c = await lock(tx, actor, id);
    policy.checkStatus(c.status, ['submitted'], 'sent back for a recount');
    if ((await counts.requestRecount(tx, id, bookIds)) !== bookIds.length) {
      throw new ValidationError('Only books on the count can be recounted', { field: 'bookIds' });
    }
    await counts.setStatus(tx, id, 'counting');
    await audit(tx, actor, id, { action: 'recount', bookIds });
    return view(tx, found(await counts.findCount(tx, id)), actor);
  });
}

/**
 * One adjustment per difference at the average cost, reason "count", linked
 * to the count (decision 6a). Books never counted stay as they are, unless
 * named to be counted as 0 (decision 5a).
 */
export async function post(actor: Actor, id: number, zeroBookIds: number[]): Promise<StockCountView> {
  return withTransaction({}, async (tx) => {
    const c = await lock(tx, actor, id);
    policy.checkStatus(c.status, ['submitted'], 'posted');
    const uncounted = new Set((await counts.lines(tx, id)).filter((l) => l.countedQuantity === null).map((l) => l.bookId));
    if (zeroBookIds.some((b) => !uncounted.has(b))) {
      throw new ValidationError('Only books on the count that were never counted can be counted as 0', { field: 'zeroBookIds' });
    }
    await count(tx, actor, c, zeroBookIds.map((bookId) => ({ bookId, quantity: 0 })));

    const lines = [...(await counts.lines(tx, id))].sort((a, b) => a.bookId - b.bookId);
    for (const line of lines) {
      const diff = policy.difference(line);
      if (diff === null) continue;
      const unitCost = diff === 0 ? null : (await inventoryService.postCountDifference(tx, {
        bookId: line.bookId, locationId: c.locationId, delta: diff, countId: id, countNumber: c.countNumber, staffCtx: actor,
      })).unitCost;
      await counts.setPosted(tx, line.id, diff, unitCost);
    }
    await counts.setStatus(tx, id, 'posted', { staffId: actor.staffId });
    const totals = policy.totals(await counts.lines(tx, id));
    await audit(tx, actor, id, {
      action: 'post', zeroBookIds, overQuantity: totals.overQuantity, shortQuantity: totals.shortQuantity,
      overValue: totals.overValue.toFixed(2), shortValue: totals.shortValue.toFixed(2),
    });
    return view(tx, found(await counts.findCount(tx, id)), actor);
  });
}

export async function cancel(actor: Actor, id: number, reason: string): Promise<StockCountView> {
  return withTransaction({}, async (tx) => {
    const c = await lock(tx, actor, id);
    policy.checkStatus(c.status, ['counting', 'submitted'], 'cancelled');
    await counts.setStatus(tx, id, 'cancelled', { staffId: actor.staffId, reason });
    await audit(tx, actor, id, { action: 'cancel', reason });
    return view(tx, found(await counts.findCount(tx, id)), actor);
  });
}
