import type {
  CreateSupplierRequest,
  LifecycleStatus,
  LinkBookSupplierRequest,
  SupplierUsage,
  UpdateSupplierRequest,
} from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './supplier.policy.js';
import * as suppliers from './supplier.repository.js';
import type { Actor, BookSupplierRecord, SupplierFilter, SupplierRecord } from './supplier.types.js';

/** Use cases of the Suppliers module (A4): one function each, owning its transaction. */

function audit(q: Queryable, actor: Actor, action: string, entityType: string, entityId: string | number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType,
    entityId,
    meta,
  });
}

async function getOrThrow(q: Queryable, id: number): Promise<SupplierRecord> {
  const supplier = await suppliers.findById(q, id);
  if (!supplier) throw new NotFoundError('Supplier');
  return supplier;
}

export async function listSuppliers(
  filter: SupplierFilter,
  paging: { page: number; pageSize: number },
): Promise<{ items: SupplierRecord[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const { page, pageSize } = paging;
  const { items, total } = await suppliers.list(kysely, filter, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export function getSupplier(id: number): Promise<SupplierRecord> {
  return getOrThrow(kysely, id);
}

export async function createSupplier(actor: Actor, dto: CreateSupplierRequest): Promise<SupplierRecord> {
  const publisherId = dto.publisherId ?? null;
  policy.checkSupplierType(dto.supplierType, publisherId);

  return withTransaction({}, async (tx) => {
    let id: number;
    try {
      id = await suppliers.insert(tx, {
        name: dto.name,
        contactInfo: dto.contactInfo,
        leadTimeDays: dto.leadTimeDays ?? 7,
        pricingTerms: dto.pricingTerms ?? null,
        supplierType: dto.supplierType,
        publisherId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('DUPLICATE_SUPPLIER_NAME', `Supplier '${dto.name}' already exists`);
      }
      throw err;
    }
    await audit(tx, actor, 'CREATE', 'supplier', id, { name: dto.name });
    return getOrThrow(tx, id);
  });
}

export async function updateSupplier(actor: Actor, id: number, dto: UpdateSupplierRequest): Promise<SupplierRecord> {
  return withTransaction({}, async (tx) => {
    const current = await suppliers.findForUpdate(tx, id);
    if (!current) throw new NotFoundError('Supplier');

    const type = policy.typeAfterUpdate(current, dto);
    if (type) policy.checkSupplierType(type.supplierType, type.publisherId);

    if (Object.values(dto).every((v) => v === undefined)) return getOrThrow(tx, id);

    try {
      await suppliers.update(tx, id, dto);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('DUPLICATE_SUPPLIER_NAME', `Supplier '${dto.name}' already exists`);
      }
      throw err;
    }
    await audit(tx, actor, 'UPDATE', 'supplier', id, dto);
    return getOrThrow(tx, id);
  });
}

async function transition(actor: Actor, id: number, action: policy.LifecycleAction): Promise<void> {
  await withTransaction({}, async (tx) => {
    const current = await suppliers.findForUpdate(tx, id);
    if (!current) throw new NotFoundError('Supplier');

    const next = policy.lifecycleTransition(action);
    await suppliers.setLifecycle(tx, id, next, actor.staffId);
    const meta: { previousStatus: LifecycleStatus; newStatus: LifecycleStatus } = {
      previousStatus: current.status,
      newStatus: next.status,
    };
    await audit(tx, actor, action, 'supplier', id, meta);
  });
}

export const deactivateSupplier = (actor: Actor, id: number) => transition(actor, id, 'INACTIVATE');
export const activateSupplier = (actor: Actor, id: number) => transition(actor, id, 'ACTIVATE');
/** Archived suppliers are hidden from the default list and cannot receive new purchase orders. */
export const archiveSupplier = (actor: Actor, id: number) => transition(actor, id, 'ARCHIVE');
export const restoreSupplier = (actor: Actor, id: number) => transition(actor, id, 'RESTORE');

export async function blacklistSupplier(actor: Actor, id: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    if (!(await suppliers.setBlacklisted(tx, id))) throw new NotFoundError('Supplier');
    await audit(tx, actor, 'UPDATE', 'supplier', id, { action: 'blacklist' });
  });
}

export async function getSupplierUsage(id: number): Promise<SupplierUsage> {
  await getOrThrow(kysely, id);
  return { purchaseOrders: await suppliers.countPurchaseOrders(kysely, id) };
}

export async function deleteSupplier(actor: Actor, id: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    policy.checkDeletable({ purchaseOrders: await suppliers.countPurchaseOrders(tx, id) });
    if (!(await suppliers.remove(tx, id))) throw new NotFoundError('Supplier');
    await audit(tx, actor, 'DELETE', 'supplier', id, { action: 'delete' });
  });
}

/**
 * Throws SUPPLIER_INACTIVE or SUPPLIER_BLACKLISTED unless the supplier can
 * take a new purchase order. Used by procurement; `q` lets a caller run it
 * inside its own transaction.
 */
export async function validateSupplierForProcurement(supplierId: number, q: Queryable = kysely): Promise<void> {
  const flags = await suppliers.findProcurementFlags(q, supplierId);
  if (!flags) throw new NotFoundError('Supplier');
  policy.checkUsableForProcurement(flags);
}

export function listBookSuppliers(bookId: number): Promise<BookSupplierRecord[]> {
  return suppliers.listForBook(kysely, bookId);
}

export async function linkBookSupplier(actor: Actor, bookId: number, dto: LinkBookSupplierRequest): Promise<void> {
  const link = {
    bookId,
    supplierId: dto.supplierId,
    supplierSku: dto.supplierSku ?? null,
    isPrimary: dto.isPrimary ?? false,
  };
  await withTransaction({}, async (tx) => {
    // A book has at most one primary supplier (unique partial index).
    if (link.isPrimary) await suppliers.clearPrimaryForBook(tx, bookId);
    await suppliers.upsertBookLink(tx, link);
    await audit(tx, actor, 'CREATE', 'book_supplier', `${bookId}:${dto.supplierId}`, link);
  });
}

export async function unlinkBookSupplier(actor: Actor, bookId: number, supplierId: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    await suppliers.deleteBookLink(tx, bookId, supplierId);
    await audit(tx, actor, 'DELETE', 'book_supplier', `${bookId}:${supplierId}`, { bookId, supplierId });
  });
}
