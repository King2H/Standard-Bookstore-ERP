import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BranchAccessError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { poNumber } from '../procurement/procurement.mapper.js';
import * as orders from '../procurement/procurement.repository.js';
import type { PurchaseOrderRecord } from '../procurement/procurement.types.js';
import { creditForReturn } from '../procurement/supplierPayables.service.js';
import * as policy from './supplierReturns.policy.js';
import * as returns from './supplierReturns.repository.js';
import type { Actor, Paging, ReturnLineInput, SupplierReturnFilter, SupplierReturnRecord, SupplierReturnView } from './supplierReturns.types.js';

/**
 * Use cases of returns to supplier (A4, #173, owner decisions 1a–6a,
 * 2026-10-30): drafting, sending and cancelling a return. One function
 * each, owning its transaction; each locks the return, then its order, so
 * two returns of one order take turns and cannot together send back more
 * than arrived.
 */

function found<T>(record: T | undefined, entity: string): T {
  if (record === undefined) throw new NotFoundError(entity);
  return record;
}

function audit(q: Queryable, actor: Actor, id: number, meta: Record<string, unknown>, action: 'CREATE' | 'UPDATE' = 'UPDATE') {
  return insertAuditEntry(q, {
    staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action, entityType: 'supplier_return', entityId: String(id), meta,
  });
}

/** The order, locked; its copies leave from the receiving branch, the session's (decision 5a). */
async function lockOrder(q: Queryable, actor: Actor, poId: string): Promise<PurchaseOrderRecord> {
  const po = found(await orders.findOrder(q, poId, { forUpdate: true }), 'Purchase Order');
  if (po.receivingBranchId !== actor.branchId) throw new BranchAccessError(po.receivingBranchId);
  return po;
}

async function lockReturn(q: Queryable, actor: Actor, id: number): Promise<SupplierReturnRecord> {
  const r = found(await returns.findReturn(q, id, { forUpdate: true }), 'Supplier return');
  if (r.branchId !== actor.branchId) throw new BranchAccessError(r.branchId);
  return r;
}

/** Lines of this order, within what arrived less what went back (decision 1a). */
async function checkLines(q: Queryable, po: PurchaseOrderRecord, lines: ReturnLineInput[]) {
  const orderLines = await returns.orderLines(q, po.id);
  for (const l of lines) found(orderLines.get(String(l.poLineItemId)), 'Purchase order line');
  policy.checkWithinReceived(lines, orderLines, await returns.sentQuantities(q, po.id));
  return orderLines;
}

async function view(q: Queryable, id: number): Promise<SupplierReturnView> {
  const r = found(await returns.findReturn(q, id), 'Supplier return');
  return { ...r, lines: await returns.lines(q, id) };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export const getById = (id: number): Promise<SupplierReturnView> => view(kysely, id);

export function list(filter: SupplierReturnFilter, paging: Paging): Promise<{ items: SupplierReturnRecord[]; total: number }> {
  return returns.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Drafting (decisions 1a, 2a) ───────────────────────────────────────────────

export async function create(actor: Actor, input: { poId: string; notes: string | null; lines: ReturnLineInput[] }): Promise<SupplierReturnView> {
  return withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, actor, input.poId);
    const orderLines = await checkLines(tx, po, input.lines);
    const returnNumber = await nextDailyNumber(tx, 'RTS');
    const id = await returns.insertReturn(tx, {
      returnNumber, poId: po.id, branchId: po.receivingBranchId, supplierId: po.supplierId, notes: input.notes, createdBy: actor.staffId,
    });
    await returns.replaceLines(tx, id, input.lines, orderLines);
    await audit(tx, actor, id, { action: 'draft', returnNumber, poNumber: poNumber(po.id), lines: input.lines }, 'CREATE');
    return view(tx, id);
  });
}

/** A draft's lines replaced; its notes too when given. */
export async function update(actor: Actor, id: number, input: { notes?: string | null; lines: ReturnLineInput[] }): Promise<SupplierReturnView> {
  return withTransaction({}, async (tx) => {
    const r = await lockReturn(tx, actor, id);
    policy.checkStatus(r.status, ['draft'], 'edited');
    const po = await lockOrder(tx, actor, r.poId);
    const orderLines = await checkLines(tx, po, input.lines);
    await returns.replaceLines(tx, id, input.lines, orderLines);
    if (input.notes !== undefined) await returns.setNotes(tx, id, input.notes);
    await audit(tx, actor, id, { action: 'edit', lines: input.lines });
    return view(tx, id);
  });
}

// ── Sending (decisions 2a, 3a, 4a) ────────────────────────────────────────────

/**
 * The copies leave at their cost, linked to the return; the order is
 * credited at its price. What arrived is checked again: another return of
 * the order may have gone first.
 */
export async function send(actor: Actor, id: number): Promise<SupplierReturnView> {
  return withTransaction({}, async (tx) => {
    const r = await lockReturn(tx, actor, id);
    policy.checkStatus(r.status, ['draft'], 'sent');
    const po = await lockOrder(tx, actor, r.poId);
    const lines = await returns.lines(tx, id);
    await checkLines(tx, po, lines.map((l) => ({ poLineItemId: Number(l.poLineItemId), locationId: l.locationId, source: l.source, quantity: l.quantity })));

    // In book and location order, so two returns lock the stock rows in the same order.
    const ordered = [...lines].sort((a, b) => a.bookId - b.bookId || a.locationId - b.locationId || a.source.localeCompare(b.source));
    for (const line of ordered) {
      const { unitCost } = await inventoryService.returnToSupplier(tx, {
        bookId: line.bookId, locationId: line.locationId, quantity: line.quantity, source: line.source, returnId: id, returnNumber: r.returnNumber, staffCtx: actor,
      });
      line.unitCost = unitCost;
      await returns.setLineCost(tx, line.id, unitCost);
    }
    const credit = policy.creditValue(lines);
    const cost = policy.costValue(lines)!;
    // Copies the supplier gave free credit nothing.
    const note = credit.greaterThan(0) ? await creditForReturn(tx, actor, po, { amount: credit, returnNumber: r.returnNumber }) : null;
    await returns.setSent(tx, id, actor.staffId, note?.id ?? null);
    await audit(tx, actor, id, {
      action: 'send', returnNumber: r.returnNumber, poNumber: poNumber(po.id), creditValue: credit.toFixed(2), costValue: cost.toFixed(2),
      creditNoteNumber: note?.creditNoteNumber ?? null,
    });
    return view(tx, id);
  });
}

export async function cancel(actor: Actor, id: number, reason: string): Promise<SupplierReturnView> {
  return withTransaction({}, async (tx) => {
    const r = await lockReturn(tx, actor, id);
    policy.checkStatus(r.status, ['draft'], 'cancelled');
    await returns.setCancelled(tx, id, actor.staffId, reason);
    await audit(tx, actor, id, { action: 'cancel', reason });
    return view(tx, id);
  });
}
