import { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { BranchAccessError, BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { getPOApprovalThreshold } from '../config/config.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { assertAssignedLocation } from '../location/location.service.js';
import { validateSupplierForProcurement } from '../supplier/supplier.service.js';
import { poNumber } from './procurement.mapper.js';
import * as policy from './procurement.policy.js';
import * as orders from './procurement.repository.js';
import type {
  Actor,
  NewLine,
  NewPurchaseOrder,
  Paging,
  PurchaseOrderChanges,
  PurchaseOrderFilter,
  PurchaseOrderRecord,
  Receipt,
} from './procurement.types.js';

/**
 * Use cases of purchase orders (A4): from a draft to goods on the shelf. One
 * function each, owning its transaction; each locks the order, so two people
 * acting on it at once take turns. Supplier payments and credit notes are in
 * supplierPayables.service.ts.
 */

function found(po: PurchaseOrderRecord | undefined): PurchaseOrderRecord {
  if (po === undefined) throw new NotFoundError('Purchase Order');
  return po;
}

function audit(q: Queryable, actor: Actor, id: string, meta: Record<string, unknown>, action: 'CREATE' | 'UPDATE' = 'UPDATE') {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'purchase_order',
    entityId: id,
    meta,
  });
}

async function lockOrder(q: Queryable, id: string): Promise<PurchaseOrderRecord> {
  return found(await orders.findOrder(q, id, { forUpdate: true }));
}

/** Sets the order's financial status from what was received, paid and credited. The caller holds the order's lock. */
export async function refreshFinancialStatus(q: Queryable, poId: string): Promise<void> {
  const { received, settled } = await orders.settlement(q, poId);
  await orders.setFinancialStatus(q, poId, policy.financialStatus(received, settled));
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getById(id: string): Promise<PurchaseOrderRecord> {
  const po = found(await orders.findOrder(kysely, id));
  const [lineItems, receipts, payments, creditNotes] = await Promise.all([
    orders.lineItems(kysely, id),
    orders.receipts(kysely, id),
    orders.payments(kysely, id),
    orders.creditNotes(kysely, id),
  ]);
  return { ...po, lineItems, receipts, payments, creditNotes };
}

export function list(filter: PurchaseOrderFilter, paging: Paging): Promise<{ items: PurchaseOrderRecord[]; total: number }> {
  return orders.list(kysely, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

// ── Drafting ──────────────────────────────────────────────────────────────────

async function checkBooks(q: Queryable, lines: NewLine[]): Promise<void> {
  for (const line of lines) {
    if (!(await orders.isBookActive(q, line.bookId))) throw new NotFoundError(`Book ${line.bookId}`);
  }
}

async function checkReceivingBranch(q: Queryable, branchId: number): Promise<void> {
  const active = await orders.isBranchActive(q, branchId);
  if (active === undefined) throw new NotFoundError('Branch');
  if (!active) throw new BusinessError('BRANCH_INACTIVE', 'The receiving branch is inactive');
}

/** The named location, which must be the receiving branch's, or that branch's default location. */
async function receivingLocation(q: Queryable, branchId: number, locationId: number | null): Promise<number | null> {
  if (locationId === null) return orders.defaultLocation(q, branchId);
  if ((await orders.locationBranch(q, locationId)) !== branchId) {
    throw new ValidationError('Receiving location does not exist or does not belong to the receiving branch', {
      field: 'receivingLocationId',
    });
  }
  return locationId;
}

export async function createPurchaseOrder(actor: Actor, input: NewPurchaseOrder): Promise<PurchaseOrderRecord> {
  const id = await withTransaction({}, async (tx) => {
    await validateSupplierForProcurement(input.supplierId, tx);
    await checkBooks(tx, input.lineItems);
    const receivingBranchId = input.receivingBranchId ?? input.branchId;
    await checkReceivingBranch(tx, receivingBranchId);
    const locationId = await receivingLocation(tx, receivingBranchId, input.receivingLocationId);
    const total = policy.orderTotal(input.lineItems);

    const id = await orders.insertOrder(tx, {
      branchId: input.branchId,
      supplierId: input.supplierId,
      total,
      expectedDeliveryDate: input.expectedDeliveryDate,
      notes: input.notes,
      createdBy: actor.staffId,
      receivingBranchId,
      receivingLocationId: locationId,
      paymentTerms: input.paymentTerms,
    });
    await orders.replaceLines(tx, id, input.lineItems);
    await audit(tx, actor, id, { supplierId: input.supplierId, totalAmount: total.toNumber(), receivingBranchId }, 'CREATE');
    await insertOutboxEvent(tx, 'po.created', {
      poId: id,
      poNumber: poNumber(id),
      supplierName: await orders.supplierName(tx, input.supplierId),
      total: total.toNumber(),
      branchId: input.branchId,
    });
    return id;
  });
  return getById(id);
}

/**
 * Changes a draft. A new receiving branch without a location takes that
 * branch's default location, never keeping the old branch's.
 */
export async function updatePurchaseOrder(actor: Actor, id: string, ch: PurchaseOrderChanges): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkOrderingBranch(po, actor);
    policy.checkEditable(po.status);
    if (ch.supplierId !== undefined) await validateSupplierForProcurement(ch.supplierId, tx);
    if (ch.lineItems) await checkBooks(tx, ch.lineItems);

    // null takes the receiving branch back to the ordering branch.
    const branchId = ch.receivingBranchId === undefined ? po.receivingBranchId : (ch.receivingBranchId ?? po.branchId);
    let locationId: number | null | undefined;
    if (branchId !== po.receivingBranchId) await checkReceivingBranch(tx, branchId);
    if (ch.receivingLocationId !== undefined) locationId = await receivingLocation(tx, branchId, ch.receivingLocationId);
    else if (branchId !== po.receivingBranchId) locationId = await receivingLocation(tx, branchId, null);

    const total = ch.lineItems ? policy.orderTotal(ch.lineItems) : undefined;
    if (ch.lineItems) await orders.replaceLines(tx, id, ch.lineItems);
    await orders.updateOrder(tx, id, {
      supplierId: ch.supplierId,
      receivingBranchId: branchId,
      receivingLocationId: locationId,
      expectedDeliveryDate: ch.expectedDeliveryDate,
      notes: ch.notes,
      paymentTerms: ch.paymentTerms,
      total,
    });
    await audit(tx, actor, id, {
      action: 'update',
      supplierId: ch.supplierId,
      receivingBranchId: branchId,
      receivingLocationId: locationId,
      paymentTerms: ch.paymentTerms,
      totalAmount: total?.toNumber(),
      lineCount: ch.lineItems?.length,
    });
  });
  return getById(id);
}

// ── Approval and ordering ─────────────────────────────────────────────────────

/** Below the approval threshold the order is approved on submit; above it, it waits for a Manager or Admin. */
export async function submitForApproval(actor: Actor, id: string): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkOrderingBranch(po, actor);
    const threshold = Money.of(await getPOApprovalThreshold());
    const status = policy.statusAfterSubmit(po.status, po.totalAmount, threshold);
    await validateSupplierForProcurement(po.supplierId, tx);
    await orders.setStatus(tx, id, status, { approvedBy: status === 'approved' ? actor.staffId : null });
    await audit(tx, actor, id, {
      action: 'submit_for_approval',
      newStatus: status,
      totalAmount: po.totalAmount.toNumber(),
      threshold: threshold.toNumber(),
    });
    if (status === 'pending_approval') {
      await insertOutboxEvent(tx, 'po.approval_required', {
        poId: id, poNumber: poNumber(id), supplierName: po.supplierName, total: po.totalAmount.toNumber(), branchId: po.branchId,
      });
    }
  });
  return getById(id);
}

export async function approve(actor: Actor, id: string): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkOrderingBranch(po, actor);
    policy.checkCanApprove(po, actor);
    await validateSupplierForProcurement(po.supplierId, tx);
    await orders.setStatus(tx, id, 'approved', { approvedBy: actor.staffId });
    await audit(tx, actor, id, { action: 'approve' });
    await insertOutboxEvent(tx, 'po.approved', { poId: id, poNumber: poNumber(id), branchId: po.branchId });
  });
  return getById(id);
}

export async function markAsOrdered(actor: Actor, id: string): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkOrderingBranch(po, actor);
    policy.checkCanOrder(po.status);
    await validateSupplierForProcurement(po.supplierId, tx);
    await orders.setStatus(tx, id, 'ordered');
    await audit(tx, actor, id, { action: 'mark_as_ordered' });
    await insertOutboxEvent(tx, 'po.ordered', { poId: id, poNumber: poNumber(id), supplierName: po.supplierName, branchId: po.branchId });
  });
  return getById(id);
}

// ── Ending an order ───────────────────────────────────────────────────────────

export async function cancel(actor: Actor, id: string): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkOrderingBranch(po, actor);
    policy.checkCanCancel(po.status, await orders.hasReceipts(tx, id));
    await orders.setStatus(tx, id, 'cancelled');
    await audit(tx, actor, id, { action: 'cancel', previousStatus: po.status });
    await insertOutboxEvent(tx, 'po.cancelled', { poId: id, poNumber: poNumber(id), branchId: po.branchId });
  });
  return getById(id);
}

/**
 * Closes a received order, or a part-received one short when the supplier
 * will not deliver the rest (owner decision 3a). What is owed stays the value
 * received.
 */
export async function close(actor: Actor, id: string, reason: string | null): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkOrderingBranch(po, actor);
    policy.checkCanClose(po.status, reason);
    await orders.setStatus(tx, id, 'closed', { closed: { by: actor.staffId, reason } });
    await audit(tx, actor, id, { action: 'close', previousStatus: po.status, reason });
  });
  return getById(id);
}

// ── Receiving ─────────────────────────────────────────────────────────────────

/**
 * Goods arriving, booked by the receiving branch (owner decision 1a, #66):
 * into a location of that branch the staff member may use, at each line's
 * cost. A cash-terms order pays for what arrived.
 */
export async function receive(actor: Actor, id: string, receipt: Receipt): Promise<PurchaseOrderRecord> {
  await withTransaction({}, async (tx) => {
    const po = await lockOrder(tx, id);
    policy.checkReceivingBranch(po, actor);
    policy.checkCanReceive(po.status);

    const locationId = receipt.locationId ?? po.receivingLocationId;
    if (locationId === null) throw new ValidationError('No receiving location specified and PO has no default receiving location');
    const locationBranch = await orders.locationBranch(tx, locationId);
    if (locationBranch === undefined) throw new NotFoundError('Location');
    if (locationBranch !== po.receivingBranchId) throw new BranchAccessError(locationBranch);
    // The location the goods go to, named or not, is one the staff member may use.
    await assertAssignedLocation(locationId, actor);

    let value = Money.ZERO;
    for (const item of receipt.items) {
      const line = await orders.lockLine(tx, item.poLineItemId);
      if (!line) throw new NotFoundError(`PO Line Item ${item.poLineItemId}`);
      policy.checkReceiptLine(line, id, item.poLineItemId, item.quantityReceived);
      await orders.addReceived(tx, item.poLineItemId, item.quantityReceived);
      await inventoryService.receiveStock(tx, {
        bookId: line.bookId,
        locationId,
        quantity: item.quantityReceived,
        unitCost: line.unitCost,
        freeOfCharge: line.unitCost.isZero(),
        referenceType: 'purchase_order',
        referenceId: id,
        reasonCode: 'initial',
        notes: receipt.notes ?? undefined,
        staffCtx: actor,
      });
      value = value.plus(line.unitCost.times(item.quantityReceived));
    }

    const receiptId = await orders.insertReceipt(tx, {
      poId: id, locationId, receivedBy: actor.staffId, notes: receipt.notes, items: receipt.items,
    });
    const quantities = await orders.lineQuantities(tx, id);
    const status = policy.statusAfterReceipt(quantities);
    await orders.setStatus(tx, id, status);

    // Cash terms settle what arrived in this delivery, not the whole order.
    if (po.paymentTerms === 'cash' && value.greaterThan(0)) {
      await orders.insertSupplierPayment(tx, {
        poId: id,
        branchId: po.branchId,
        supplierId: po.supplierId,
        amount: value.round(2),
        paymentMethod: 'cash',
        source: 'auto_on_receipt',
        notes: `Auto-settled on receipt #${receiptId}`,
        createdBy: actor.staffId,
      });
      await refreshFinancialStatus(tx, id);
    }

    await audit(tx, actor, id, { action: 'receive', locationId, itemCount: receipt.items.length, newStatus: status });
    if (status === 'received') {
      await insertOutboxEvent(tx, 'po.fully_received', { poId: id, poNumber: poNumber(id), branchId: po.receivingBranchId });
    } else {
      await insertOutboxEvent(tx, 'po.partially_received', {
        poId: id,
        poNumber: poNumber(id),
        qtyReceived: receipt.items.reduce((s, i) => s + i.quantityReceived, 0),
        qtyOrdered: quantities.reduce((s, l) => s + l.quantity, 0),
        branchId: po.receivingBranchId,
      });
    }
  });
  return getById(id);
}
