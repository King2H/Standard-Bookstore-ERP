import { sql } from 'kysely';
import type { LifecycleStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toBookSupplierRecord, toSupplierRecord } from './supplier.mapper.js';
import type { BookSupplierRecord, NewSupplier, SupplierChanges, SupplierFilter, SupplierRecord } from './supplier.types.js';

// Suppliers are shared by all branches, so these queries take no branch scope.
// Tenant scope arrives with tenancy (#13).

function selectSuppliers(q: Queryable) {
  return q
    .selectFrom('suppliers as s')
    .leftJoin('publishers as p', 'p.id', 's.publisher_id')
    .select([
      's.id',
      's.name',
      's.contact_info',
      's.lead_time_days',
      's.pricing_terms',
      's.supplier_type',
      's.publisher_id',
      'p.name as publisher_name',
      's.is_active',
      's.is_blacklisted',
      's.status',
      's.archived_at',
      's.created_at',
    ]);
}

export async function findById(q: Queryable, id: number): Promise<SupplierRecord | undefined> {
  const row = await selectSuppliers(q).where('s.id', '=', id).executeTakeFirst();
  return row && toSupplierRecord(row);
}

export async function list(
  q: Queryable,
  filter: SupplierFilter,
  page: { limit: number; offset: number },
): Promise<{ items: SupplierRecord[]; total: number }> {
  let query = selectSuppliers(q);
  if (filter.supplierType) query = query.where('s.supplier_type', '=', filter.supplierType);
  if (filter.statuses) query = query.where('s.status', 'in', filter.statuses);
  else if (filter.isActive !== undefined) query = query.where('s.is_active', '=', filter.isActive);
  if (filter.isBlacklisted !== undefined) query = query.where('s.is_blacklisted', '=', filter.isBlacklisted);
  if (filter.nameContains) {
    query = query.where(sql`lower(s.name)`, 'like', sql`lower(${`%${filter.nameContains}%`})`);
  }

  const [rows, count] = await Promise.all([
    query.orderBy('s.name', 'asc').limit(page.limit).offset(page.offset).execute(),
    query
      .clearSelect()
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toSupplierRecord), total: Number(count.total) };
}

export async function insert(q: Queryable, supplier: NewSupplier): Promise<number> {
  const row = await q
    .insertInto('suppliers')
    .values({
      name: supplier.name,
      contact_info: JSON.stringify(supplier.contactInfo),
      lead_time_days: supplier.leadTimeDays,
      pricing_terms: supplier.pricingTerms,
      supplier_type: supplier.supplierType,
      publisher_id: supplier.publisherId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Returns false when no supplier has this id. */
export async function update(q: Queryable, id: number, changes: SupplierChanges): Promise<boolean> {
  const result = await q
    .updateTable('suppliers')
    .set({
      name: changes.name,
      contact_info: changes.contactInfo === undefined ? undefined : JSON.stringify(changes.contactInfo),
      lead_time_days: changes.leadTimeDays,
      pricing_terms: changes.pricingTerms,
      supplier_type: changes.supplierType,
      publisher_id: changes.publisherId,
      is_active: changes.isActive,
    })
    .where('id', '=', id)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** Locks the row until the transaction ends, for a read-then-write. */
export async function findForUpdate(
  q: Queryable,
  id: number,
): Promise<{ status: LifecycleStatus; supplierType: SupplierRecord['supplierType']; publisherId: number | null } | undefined> {
  const row = await q
    .selectFrom('suppliers')
    .select(['status', 'supplier_type', 'publisher_id'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  return (
    row && {
      status: row.status as LifecycleStatus,
      supplierType: row.supplier_type as SupplierRecord['supplierType'],
      publisherId: row.publisher_id,
    }
  );
}

export async function setLifecycle(
  q: Queryable,
  id: number,
  state: { status: LifecycleStatus; isActive: boolean; archived: boolean },
  staffId: number,
): Promise<void> {
  await q
    .updateTable('suppliers')
    .set({
      status: state.status,
      is_active: state.isActive,
      archived_at: state.archived ? sql<Date>`now()` : null,
      archived_by: state.archived ? staffId : null,
      updated_at: sql<Date>`now()`,
      updated_by: staffId,
    })
    .where('id', '=', id)
    .execute();
}

/** Returns false when no supplier has this id. */
export async function setBlacklisted(q: Queryable, id: number): Promise<boolean> {
  const result = await q
    .updateTable('suppliers')
    .set({ is_blacklisted: true })
    .where('id', '=', id)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** Returns false when no supplier has this id. */
export async function remove(q: Queryable, id: number): Promise<boolean> {
  const result = await q.deleteFrom('suppliers').where('id', '=', id).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

export async function countPurchaseOrders(q: Queryable, id: number): Promise<number> {
  const row = await q
    .selectFrom('purchase_orders')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('supplier_id', '=', id)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function findProcurementFlags(
  q: Queryable,
  id: number,
): Promise<{ isActive: boolean; isBlacklisted: boolean } | undefined> {
  const row = await q
    .selectFrom('suppliers')
    .select(['is_active', 'is_blacklisted'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row && { isActive: row.is_active, isBlacklisted: row.is_blacklisted };
}

export async function listForBook(q: Queryable, bookId: number): Promise<BookSupplierRecord[]> {
  const rows = await q
    .selectFrom('book_suppliers as bs')
    .innerJoin('suppliers as s', 's.id', 'bs.supplier_id')
    .select(['bs.book_id', 'bs.supplier_id', 's.name as supplier_name', 'bs.supplier_sku', 'bs.is_primary'])
    .where('bs.book_id', '=', bookId)
    .orderBy('bs.is_primary', 'desc')
    .orderBy('s.name', 'asc')
    .execute();
  return rows.map(toBookSupplierRecord);
}

export async function clearPrimaryForBook(q: Queryable, bookId: number): Promise<void> {
  await q.updateTable('book_suppliers').set({ is_primary: false }).where('book_id', '=', bookId).execute();
}

/** Creates the link, or updates its SKU and primary flag if it exists. */
export async function upsertBookLink(
  q: Queryable,
  link: { bookId: number; supplierId: number; supplierSku: string | null; isPrimary: boolean },
): Promise<void> {
  await q
    .insertInto('book_suppliers')
    .values({
      book_id: link.bookId,
      supplier_id: link.supplierId,
      supplier_sku: link.supplierSku,
      is_primary: link.isPrimary,
    })
    .onConflict((oc) =>
      oc.columns(['book_id', 'supplier_id']).doUpdateSet((eb) => ({
        supplier_sku: eb.ref('excluded.supplier_sku'),
        is_primary: eb.ref('excluded.is_primary'),
      })),
    )
    .execute();
}

export async function deleteBookLink(q: Queryable, bookId: number, supplierId: number): Promise<void> {
  await q
    .deleteFrom('book_suppliers')
    .where('book_id', '=', bookId)
    .where('supplier_id', '=', supplierId)
    .execute();
}
