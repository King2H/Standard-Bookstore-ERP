import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BranchAccessError, BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { assertAssignedLocation } from '../location/location.service.js';
import * as policy from './transfers.policy.js';
import * as transfers from './transfers.repository.js';
import type {
  Actor,
  NewTransfer,
  Paging,
  TransferFilter,
  TransferRecord,
  TransferReceipt,
  TransferResolution,
  TransferView,
} from './transfers.types.js';

/**
 * Use cases of transfers between branches (A4, #170, owner decisions 1a–5a,
 * 2026-10-26): from a draft to books on the other branch's shelves. One
 * function each, owning its transaction; each locks the note, so two people
 * acting on it at once take turns.
 */

function found(t: TransferRecord | undefined): TransferRecord {
  if (t === undefined) throw new NotFoundError('Transfer');
  return t;
}

function audit(q: Queryable, actor: Actor, id: number, meta: Record<string, unknown>, action: 'CREATE' | 'UPDATE' = 'UPDATE') {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'branch_transfer',
    entityId: String(id),
    meta,
  });
}

async function lockTransfer(q: Queryable, id: number): Promise<TransferRecord> {
  return found(await transfers.findTransfer(q, id, { forUpdate: true }));
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: number, q: Queryable = kysely): Promise<TransferView> {
  const t = found(await transfers.findTransfer(q, id));
  const [lines, events] = await Promise.all([transfers.lines(q, id), transfers.events(q, id)]);
  return { ...t, lines, events };
}

export function list(filter: TransferFilter, paging: Paging): Promise<{ items: TransferRecord[]; total: number }> {
  return transfers.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Drafting ──────────────────────────────────────────────────────────────────

/** The destination is another active branch; the books are in the catalog. */
async function checkDraft(q: Queryable, actor: Actor, input: NewTransfer): Promise<void> {
  if (input.toBranchId === actor.branchId) {
    throw new ValidationError('A transfer goes to another branch; within a branch, move stock between its locations', { field: 'toBranchId' });
  }
  const destination = await transfers.branch(q, input.toBranchId);
  if (destination === undefined) throw new NotFoundError('Branch');
  if (!destination.isActive) throw new BusinessError('BRANCH_INACTIVE', 'The receiving branch is inactive');
  // The source is the session branch's; the controller checked it, the service holds to it.
  if ((await transfers.locationBranch(q, input.fromLocationId)) !== actor.branchId) throw new BranchAccessError(actor.branchId);
  const missing = await transfers.inactiveBooks(q, input.lines.map((l) => l.bookId));
  if (missing.length) throw new NotFoundError(`Book ${missing[0]}`);
}

export async function create(actor: Actor, input: NewTransfer): Promise<TransferView> {
  return withTransaction({}, async (tx) => {
    await checkDraft(tx, actor, input);
    const transferNumber = await nextDailyNumber(tx, 'TRF');
    const id = await transfers.insertTransfer(tx, {
      transferNumber,
      fromBranchId: actor.branchId,
      fromLocationId: input.fromLocationId,
      toBranchId: input.toBranchId,
      notes: input.notes,
      createdBy: actor.staffId,
    });
    await transfers.replaceLines(tx, id, input.lines);
    await audit(tx, actor, id, {
      action: 'create', transferNumber, fromLocationId: input.fromLocationId, toBranchId: input.toBranchId, lines: input.lines,
    }, 'CREATE');
    return getById(id, tx);
  });
}

/** A draft, replaced whole. */
export async function update(actor: Actor, id: number, input: NewTransfer): Promise<TransferView> {
  return withTransaction({}, async (tx) => {
    const t = await lockTransfer(tx, id);
    policy.checkSendingBranch(t, actor);
    policy.checkEditable(t.status);
    await checkDraft(tx, actor, input);
    await transfers.updateDraft(tx, id, input);
    await transfers.replaceLines(tx, id, input.lines);
    await audit(tx, actor, id, { action: 'update', fromLocationId: input.fromLocationId, toBranchId: input.toBranchId, lines: input.lines });
    return getById(id, tx);
  });
}

export async function cancel(actor: Actor, id: number): Promise<TransferView> {
  return withTransaction({}, async (tx) => {
    const t = await lockTransfer(tx, id);
    policy.checkSendingBranch(t, actor);
    policy.checkEditable(t.status);
    await transfers.setStatus(tx, id, 'cancelled', { cancelled: actor.staffId });
    await audit(tx, actor, id, { action: 'cancel' });
    return getById(id, tx);
  });
}

// ── Sending ───────────────────────────────────────────────────────────────────

/**
 * The copies leave the source location at its average cost, kept on each
 * line, and are in transit (decision 3a). Never below zero. The receiving
 * branch is told (decision 5a).
 */
export async function dispatch(actor: Actor, id: number): Promise<TransferView> {
  return withTransaction({}, async (tx) => {
    const t = await lockTransfer(tx, id);
    policy.checkSendingBranch(t, actor);
    policy.checkCanDispatch(t.status);
    // Whoever dispatches may use the source location (#72), not only whoever drafted.
    await assertAssignedLocation(t.fromLocationId, actor);
    // In book order, so two notes from one shelf lock its rows in the same order.
    const lines = [...(await transfers.lines(tx, id))].sort((a, b) => a.bookId - b.bookId);
    for (const line of lines) {
      const { unitCost } = await inventoryService.sendStock(tx, {
        bookId: line.bookId,
        locationId: t.fromLocationId,
        quantity: line.quantity,
        transferId: id,
        notes: `${t.transferNumber} to ${t.toBranchName}`,
        staffCtx: actor,
      });
      await transfers.setUnitCost(tx, line.id, unitCost);
    }
    await transfers.setStatus(tx, id, 'in_transit', { dispatched: actor.staffId });
    const view = await getById(id, tx);
    await audit(tx, actor, id, { action: 'dispatch', inTransitValue: view.inTransitValue.toFixed(2), totalQuantity: view.totalQuantity });
    await insertOutboxEvent(tx, 'transfer.dispatched', {
      transferId: id,
      transferNumber: t.transferNumber,
      fromBranchName: t.fromBranchName,
      branchId: t.toBranchId,
      quantity: view.totalQuantity,
    });
    return view;
  });
}

// ── Receiving and resolving ───────────────────────────────────────────────────

/** Sets the note's status from its lines after a receipt or a resolution. */
async function settle(tx: Queryable, id: number): Promise<string> {
  const status = policy.statusAfter(await transfers.lines(tx, id));
  await transfers.setStatus(tx, id, status, { completed: status === 'received' || status === 'closed' });
  return status;
}

async function lineOf(tx: Queryable, transferId: number, lineId: number) {
  const line = await transfers.lockLine(tx, lineId);
  if (!line || line.transferId !== transferId) throw new NotFoundError(`Transfer line ${lineId}`);
  return line;
}

/** A location of `branchId` the staff member may use (#72). */
async function checkLocation(tx: Queryable, actor: Actor, locationId: number, branchId: number): Promise<void> {
  const locationBranch = await transfers.locationBranch(tx, locationId);
  if (locationBranch === undefined) throw new NotFoundError('Location');
  if (locationBranch !== branchId) throw new BranchAccessError(locationBranch);
  await assertAssignedLocation(locationId, actor);
}

/**
 * The receiving branch books what arrived, line by line, into one of its
 * locations: at the sender's cost, weighed into the average there (3a).
 */
export async function receive(actor: Actor, id: number, receipt: TransferReceipt): Promise<TransferView> {
  return withTransaction({}, async (tx) => {
    const t = await lockTransfer(tx, id);
    policy.checkReceivingBranch(t, actor);
    policy.checkCanReceive(t.status);
    await checkLocation(tx, actor, receipt.locationId, t.toBranchId);

    for (const item of receipt.items) {
      const line = await lineOf(tx, id, item.lineId);
      policy.checkWithinOutstanding(line, item.quantity);
      await inventoryService.receiveStock(tx, {
        bookId: line.bookId,
        locationId: receipt.locationId,
        quantity: item.quantity,
        unitCost: line.unitCost!,
        costMayBeZero: true,
        movementType: 'transfer_in',
        reasonCode: 'transfer_in',
        referenceType: 'branch_transfer',
        referenceId: id,
        notes: receipt.notes ?? `${t.transferNumber} from ${t.fromBranchName}`,
        staffCtx: actor,
      });
      await transfers.recordEvent(tx, {
        transferId: id, lineId: line.id, kind: 'received', quantity: item.quantity, locationId: receipt.locationId, reason: null, staffId: actor.staffId,
      });
    }
    const status = await settle(tx, id);
    await audit(tx, actor, id, { action: 'receive', locationId: receipt.locationId, items: receipt.items, newStatus: status });
    return getById(id, tx);
  });
}

/**
 * Copies that did not arrive, resolved by an Admin or Manager with a reason
 * (decision 4a): lost, a loss at the cost they left at; damaged, into the
 * receiving location's damaged stock at that cost (#168); returned, back on
 * the sending branch's shelf at that cost.
 */
export async function resolve(actor: Actor, id: number, r: TransferResolution): Promise<TransferView> {
  return withTransaction({}, async (tx) => {
    const t = await lockTransfer(tx, id);
    policy.checkResolverBranch(t, actor, r.outcome);
    policy.checkCanReceive(t.status);
    const line = await lineOf(tx, id, r.lineId);
    policy.checkWithinOutstanding(line, r.quantity);
    const unitCost = line.unitCost!;
    const common = { bookId: line.bookId, quantity: r.quantity, referenceType: 'branch_transfer', referenceId: id, notes: `${t.transferNumber}: ${r.reason}`, staffCtx: actor };

    if (r.outcome === 'damaged') {
      await checkLocation(tx, actor, r.locationId!, t.toBranchId);
      await inventoryService.receiveDamaged(tx, { ...common, locationId: r.locationId!, unitCost, reasonCode: 'damage' });
    } else if (r.outcome === 'returned') {
      await checkLocation(tx, actor, r.locationId!, t.fromBranchId);
      await inventoryService.receiveStock(tx, {
        ...common, locationId: r.locationId!, unitCost, costMayBeZero: true, movementType: 'transfer_in', reasonCode: 'transfer_returned',
      });
    }
    await transfers.recordEvent(tx, {
      transferId: id, lineId: line.id, kind: r.outcome, quantity: r.quantity, locationId: r.locationId, reason: r.reason, staffId: actor.staffId,
    });
    const status = await settle(tx, id);
    await audit(tx, actor, id, {
      action: 'resolve',
      outcome: r.outcome,
      bookId: line.bookId,
      quantity: r.quantity,
      value: unitCost.times(r.quantity).round(2).toFixed(2),
      locationId: r.locationId,
      reason: r.reason,
      newStatus: status,
    });
    return getById(id, tx);
  });
}
