import type { LifecycleStatus } from '@bms/shared';
import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { SHOP_CURRENCY } from '../config/config.repository.js';

// Lookups of the catalog import (#246): one query per list, whatever the
// size of the file.

export interface NamedRecord {
  id: number;
  name: string;
  status: LifecycleStatus;
}

/** Authors or categories by their lower-cased name. */
export async function namesByNormalized(q: Queryable, table: 'authors' | 'categories', normalized: string[]): Promise<Map<string, NamedRecord>> {
  if (normalized.length === 0) return new Map();
  const rows = await q.selectFrom(table).select(['id', 'name', 'status', 'normalized_name']).where('normalized_name', 'in', normalized).execute();
  return new Map(rows.map((r) => [r.normalized_name, { id: r.id, name: r.name, status: r.status as LifecycleStatus }]));
}

/** Every publisher, by its lower-cased name (a shop has tens, not thousands). */
export async function publishers(q: Queryable): Promise<Map<string, NamedRecord>> {
  const rows = await q.selectFrom('publishers').select(['id', 'name', 'status']).execute();
  return new Map(rows.map((r) => [r.name.toLowerCase(), { id: r.id, name: r.name, status: r.status as LifecycleStatus }]));
}

export interface BookRef {
  id: number;
  title: string;
}

/** Books by the ISBN they are stored under (or SKU-<sku>). */
export async function booksByKey(q: Queryable, keys: string[]): Promise<Map<string, BookRef>> {
  if (keys.length === 0) return new Map();
  const rows = await q.selectFrom('books').select(['id', 'isbn', 'title']).where('isbn', 'in', keys).execute();
  return new Map(rows.map((r) => [r.isbn, { id: r.id, title: r.title }]));
}

export interface LevelRow {
  bookId: number;
  locationId: number;
  quantity: number;
  reorderPoint: number;
  hasHistory: boolean;
}

/** The stock of these books at these locations, and whether anything ever moved there. */
export async function stockLevels(q: Queryable, bookIds: number[], locationIds: number[]): Promise<LevelRow[]> {
  if (bookIds.length === 0 || locationIds.length === 0) return [];
  const rows = await q
    .selectFrom('inventory as i')
    .select((eb) => [
      'i.book_id', 'i.location_id', 'i.quantity', 'i.reorder_point',
      eb.exists(eb.selectFrom('inventory_history as h').select('h.id').whereRef('h.book_id', '=', 'i.book_id').whereRef('h.location_id', '=', 'i.location_id')).as('has_history'),
    ])
    .where('i.book_id', 'in', bookIds)
    .where('i.location_id', 'in', locationIds)
    .execute();
  return rows.map((r) => ({ bookId: r.book_id, locationId: r.location_id, quantity: r.quantity, reorderPoint: r.reorder_point, hasHistory: Boolean(r.has_history) }));
}

export interface StockExportRow {
  isbn: string;
  title: string;
  location: string;
  quantity: number;
  averageCost: string;
  reorderPoint: number;
}

/** A branch's stock lines, for its export. */
export async function branchStock(q: Queryable, branchId: number): Promise<StockExportRow[]> {
  const rows = await q
    .selectFrom('inventory as i')
    .innerJoin('books as b', 'b.id', 'i.book_id')
    .innerJoin('locations as l', 'l.id', 'i.location_id')
    .select(['b.isbn', 'b.title', 'l.name as location', 'i.quantity', 'i.average_cost', 'i.reorder_point'])
    .where('l.branch_id', '=', branchId)
    .orderBy('b.title').orderBy('l.name')
    .execute();
  return rows.map((r) => ({ isbn: r.isbn, title: r.title, location: r.location, quantity: r.quantity, averageCost: String(r.average_cost), reorderPoint: r.reorder_point }));
}

export interface CustomerRef {
  id: number;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  phoneLookup: string | null;
  emailLookup: string | null;
}

/** Customers by code, phone or email lookup hash. */
export async function customersByKeys(q: Queryable, codes: string[], phoneLookups: string[], emailLookups: string[]): Promise<CustomerRef[]> {
  if (codes.length + phoneLookups.length + emailLookups.length === 0) return [];
  const rows = await q
    .selectFrom('customers')
    .select(['id', 'customer_code', 'full_name', 'address', 'city', 'phone_lookup', 'email_lookup'])
    .where((eb) => eb.or([
      ...(codes.length ? [eb('customer_code', 'in', codes)] : []),
      ...(phoneLookups.length ? [eb('phone_lookup', 'in', phoneLookups)] : []),
      ...(emailLookups.length ? [eb('email_lookup', 'in', emailLookups)] : []),
    ]))
    .execute();
  return rows.map((r) => ({
    id: r.id, code: r.customer_code, name: r.full_name, address: r.address, city: r.city, phoneLookup: r.phone_lookup, emailLookup: r.email_lookup,
  }));
}

/** Whether the shop has sold anything yet: opening balances come in only before (#246). */
export async function hasSales(q: Queryable): Promise<boolean> {
  const row = await q
    .selectNoFrom((eb) => [
      eb.or([
        eb.exists(eb.selectFrom('transactions').select('id')),
        eb.exists(eb.selectFrom('orders').select('id').where(sql`upper(status)`, '<>', 'DRAFT')),
      ]).as('sold'),
    ])
    .executeTakeFirstOrThrow();
  return Boolean(row.sold);
}

export interface OpeningCustomerBalances {
  owed: Map<number, string>;
  storeCredit: Map<number, string>;
  points: Map<number, number>;
}

/** The opening balances these customers already have. */
export async function openingCustomerBalances(q: Queryable, customerIds: number[]): Promise<OpeningCustomerBalances> {
  const result: OpeningCustomerBalances = { owed: new Map(), storeCredit: new Map(), points: new Map() };
  if (customerIds.length === 0) return result;
  const owed = await q.selectFrom('receivables').select(['customer_id', 'original_amount'])
    .where('source_type', '=', 'opening_balance').where('customer_id', 'in', customerIds).execute();
  for (const r of owed) result.owed.set(r.customer_id, String(r.original_amount));
  const credit = await q.selectFrom('store_credit_history').select(['customer_id', sql<string>`SUM(amount)`.as('amount')])
    .where('ref_type', '=', 'opening_balance').where('customer_id', 'in', customerIds).groupBy('customer_id').execute();
  for (const r of credit) result.storeCredit.set(r.customer_id, String(r.amount));
  const points = await q.selectFrom('loyalty_history').select(['customer_id', sql<string>`SUM(points_delta)`.as('points')])
    .where('reason', '=', 'OPENING_BALANCE').where('customer_id', 'in', customerIds).groupBy('customer_id').execute();
  for (const r of points) result.points.set(r.customer_id, Number(r.points));
  return result;
}

/** Suppliers by lower-cased name, with the opening balance each already has. */
export async function suppliersByName(q: Queryable): Promise<Map<string, { id: number; name: string; openingOwed: string | null }>> {
  const rows = await q
    .selectFrom('suppliers as s')
    .leftJoin('purchase_orders as po', (j) => j.onRef('po.supplier_id', '=', 's.id').on('po.kind', '=', 'opening_balance'))
    .select(['s.id', 's.name', 'po.total_amount'])
    .execute();
  return new Map(rows.map((r) => [r.name.toLowerCase(), { id: r.id, name: r.name, openingOwed: r.total_amount === null ? null : String(r.total_amount) }]));
}

/** What the shop owed a supplier at the start (#246): a received purchase order with no lines. */
export async function insertOpeningPurchaseOrder(
  q: Queryable,
  po: { poNumber: string; supplierId: number; branchId: number; amount: string; createdBy: number; notes: string },
): Promise<string> {
  const row = await q
    .insertInto('purchase_orders')
    .values({
      po_number: po.poNumber, kind: 'opening_balance', supplier_id: po.supplierId, branch_id: po.branchId, receiving_branch_id: po.branchId,
      status: 'received', financial_status: 'unpaid', payment_terms: 'credit', total_amount: po.amount, currency: SHOP_CURRENCY,
      created_by: po.createdBy, notes: po.notes,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}
