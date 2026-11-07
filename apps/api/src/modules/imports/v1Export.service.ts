import {
  CATALOG_IMPORT_COLUMNS, CUSTOMER_BALANCE_IMPORT_COLUMNS, CUSTOMER_IMPORT_COLUMNS, Money, OPENING_STOCK_IMPORT_COLUMNS,
  SUPPLIER_BALANCE_IMPORT_COLUMNS,
} from '@bms/shared';
import { buildCsv } from '../../lib/csvBuilder.js';
import { checkColumnKey, contactOf, databaseKind, formatOf, plural, wholePoints } from './v1Export.policy.js';
import * as repo from './v1Export.repository.js';

/**
 * The import from a v1 shop (#246 part 5, owner decisions 1a–4a): a copy of
 * the v1 database, loaded into a temporary database, read into the five
 * files of the Import / Export page. The files are imported there, in their
 * order, with the page's checks; nothing here writes to the v2 shop.
 */

export interface V1File {
  /** The file name, numbered as the page's steps. */
  name: string;
  /** The file, with a byte-order mark for Excel. */
  csv: string;
  rows: number;
}

export interface V1Export {
  files: V1File[];
  /** What came over and what did not, in plain words: written beside the files. */
  summary: string[];
}

const V1_LAST = '1700000050_pos_payment_mobile';

function csvOf(columns: readonly string[], rows: Array<Record<string, string>>): string {
  return '\uFEFF' + buildCsv(rows, columns.map((c) => ({ key: c, header: c, type: 'string' as const })));
}

/** An amount for a file: empty when zero. */
const amount = (m: Money) => (m.isZero() ? '' : m.toFixed(2));

/** Checks the copy is v1 at its last migration, and that the key opens every contact. */
async function checkCopy(db: repo.V1Db, keyHex: string): Promise<void> {
  const described = await repo.describeDatabase(db);
  const kind = databaseKind(described);
  if (kind === 'v2') throw new Error('This is a v2 database: restore a v2 backup with restore.ps1 or restore.sh instead.');
  if (kind !== 'v1') throw new Error('This is not a database of the bookstore v1.');
  if (described.lastMigration !== V1_LAST) {
    throw new Error(`This v1 database is at migration ${described.lastMigration}: bring v1 up to its last release (1.1.x) first, then copy it again.`);
  }
  const contacts = (await repo.customers(db)).flatMap((c) => [c.phoneEncrypted, c.emailEncrypted]).filter((v): v is string => !!v);
  const { checked, unreadable } = checkColumnKey(contacts, keyHex);
  if (unreadable > 0) {
    throw new Error(`The key does not open ${unreadable} of the ${checked} encrypted contacts: use COLUMN_ENCRYPTION_KEY of the v1 API (on Render: the API service, Environment).`);
  }
}

export async function exportV1Shop(db: repo.V1Db, keyHex: string): Promise<V1Export> {
  await checkCopy(db, keyHex);
  const files: V1File[] = [];
  const summary: string[] = [];
  const branches = await repo.branchNames(db);
  summary.push(`From the v1 shop: ${plural(branches.length, 'branch', 'branches')} (${branches.join(', ')}).`);

  // 1. Catalog: every book but those archived with no stock.
  const allBooks = await repo.books(db);
  const shopFormats = await repo.formats(db);
  const unknownFormats = new Map<string, number>();
  const kept = allBooks.filter((b) => b.status !== 'ARCHIVED' || b.inStock);
  const catalog = kept.map((b) => {
    const format = formatOf(b.formatLabel, b.formatText, shopFormats);
    if (format === null) unknownFormats.set(b.formatText!.trim(), (unknownFormats.get(b.formatText!.trim()) ?? 0) + 1);
    return {
      ISBN: b.isbn, SKU: b.sku ?? '', Title: b.title, Authors: b.authors ?? '', Publisher: b.publisher ?? '',
      Categories: b.categories ?? b.genre?.trim() ?? '', Format: format ?? '', Language: b.language ?? '', Price: b.price ?? '',
    };
  });
  files.push({ name: '1-catalog.csv', csv: csvOf(CATALOG_IMPORT_COLUMNS, catalog), rows: catalog.length });
  summary.push('', `1-catalog.csv: ${plural(catalog.length, 'book')}.`);
  const archived = allBooks.length - kept.length;
  if (archived > 0) summary.push(`  ${plural(archived, 'book')} archived in v1, with no stock, ${archived === 1 ? 'is' : 'are'} left out.`);
  for (const [text, n] of unknownFormats) {
    summary.push(`  Format "${text}" (${plural(n, 'book')}) is not one of v2's formats: left empty, to set on the book after the import.`);
  }

  // 2. Opening stock: one file per branch with stock, at the v1 average cost.
  const lines = await repo.stock(db);
  const byBranch = new Map<string, repo.V1Stock[]>();
  for (const line of lines) byBranch.set(line.branch, [...(byBranch.get(line.branch) ?? []), line]);
  for (const [branch, rows] of byBranch) {
    const good = rows.filter((r) => r.quantity > 0);
    const name = byBranch.size === 1 ? '2-opening-stock.csv' : `2-opening-stock-${branch.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}.csv`;
    files.push({
      name,
      csv: csvOf(OPENING_STOCK_IMPORT_COLUMNS, good.map((r) => ({
        ISBN: r.isbn, Title: r.title, Location: r.location, Quantity: String(r.quantity), 'Unit Cost': r.unitCost, 'Reorder Point': String(r.reorderPoint),
      }))),
      rows: good.length,
    });
    const copies = good.reduce((n, r) => n + r.quantity, 0);
    summary.push('', `${name}: ${plural(good.length, 'line')}, ${plural(copies, 'copy', 'copies')}, for branch ${branch}: import it signed in to that branch.`);
    summary.push(`  Locations: ${[...new Set(good.map((r) => r.location))].sort().join(', ')}. Each must exist in v2 under the same name first (Organization → Locations).`);
    const free = good.filter((r) => Money.of(r.unitCost).isZero()).length;
    if (free > 0) summary.push(`  ${plural(free, 'line')} at cost 0: ${free === 1 ? 'it comes' : 'they come'} in at 0 and ${free === 1 ? 'is' : 'are'} listed for Revalue.`);
    const damaged = rows.reduce((n, r) => n + r.damaged, 0);
    if (damaged > 0) summary.push(`  ${plural(damaged, 'damaged copy', 'damaged copies')} ${damaged === 1 ? 'is' : 'are'} not brought over.`);
    const negative = rows.filter((r) => r.quantity < 0);
    for (const r of negative) summary.push(`  ${r.title} at ${r.location}: ${r.quantity} in v1, below zero: not brought over; count it after the import.`);
  }

  // 3. Customers, and 4. their balances: all but those archived with nothing to carry.
  const people = (await repo.customers(db)).map((c) => ({
    ...c, owedM: Money.of(c.owed), creditM: Money.of(c.credit), wholePoints: wholePoints(c.points),
  }));
  const carried = people.filter((c) => !c.owedM.isZero() || !c.creditM.isZero() || c.wholePoints > 0);
  const listed = people.filter((c) => c.status !== 'ARCHIVED' || carried.includes(c));
  files.push({
    name: '3-customers.csv',
    csv: csvOf(CUSTOMER_IMPORT_COLUMNS, listed.map((c) => ({
      Code: c.code, Name: c.name, Phone: contactOf(c.phoneEncrypted, c.phone, keyHex), Email: contactOf(c.emailEncrypted, c.email, keyHex),
      Address: c.address ?? '', City: c.city ?? '',
    }))),
    rows: listed.length,
  });
  summary.push('', `3-customers.csv: ${plural(listed.length, 'customer')}, keeping their v1 codes.`);
  if (people.length > listed.length) summary.push(`  ${plural(people.length - listed.length, 'customer')} archived in v1, with nothing owed or held, left out.`);
  summary.push('  It holds phones and emails in clear: keep it private, and delete it once imported.');

  const today = new Date().toISOString().slice(0, 10);
  files.push({
    name: '4-customer-balances.csv',
    csv: csvOf(CUSTOMER_BALANCE_IMPORT_COLUMNS, carried.map((c) => ({
      Code: c.code, Phone: '', Email: '', 'Amount Owed': amount(c.owedM), 'Due Date': c.owedM.isZero() ? '' : c.due ?? today,
      'Store Credit': amount(c.creditM), 'Loyalty Points': c.wholePoints > 0 ? String(c.wholePoints) : '',
    }))),
    rows: carried.length,
  });
  summary.push('', `4-customer-balances.csv: ${plural(carried.length, 'customer')}: owed ${Money.sum(carried.map((c) => c.owedM)).toFixed(2)},`
    + ` store credit ${Money.sum(carried.map((c) => c.creditM)).toFixed(2)}, ${plural(carried.reduce((n, c) => n + c.wholePoints, 0), 'point')}.`);
  for (const c of carried) {
    if (!c.owedM.isZero() && !c.due) summary.push(`  ${c.code} had no due date in v1: due ${today} in the file; change it there if needed.`);
    if (Number(c.points) !== c.wholePoints) summary.push(`  ${c.code}: ${Number(c.points)} points in v1, ${c.wholePoints} here (v2 counts whole points).`);
  }

  // 5. What the shop owes each supplier.
  const vendors = (await repo.suppliers(db)).map((s) => ({ ...s, owedM: Money.of(s.owed) }));
  const owing = vendors.filter((s) => s.owedM.greaterThan(0));
  files.push({
    name: '5-supplier-balances.csv',
    csv: csvOf(SUPPLIER_BALANCE_IMPORT_COLUMNS, owing.map((s) => ({ Supplier: s.name, Phone: s.phone ?? '', Email: s.email ?? '', 'Amount Owed': s.owedM.toFixed(2) }))),
    rows: owing.length,
  });
  summary.push('', `5-supplier-balances.csv: ${plural(owing.length, 'supplier')}, owed ${Money.sum(owing.map((s) => s.owedM)).toFixed(2)}`
    + ' (received, less paid, less credit notes, as v1 shows it).');
  for (const s of vendors.filter((v) => v.owedM.isNegative())) {
    summary.push(`  ${s.name}: the shop paid ${s.owedM.abs().toFixed(2)} more than it received; not in the file: settle it with the supplier.`);
  }

  if (branches.length > 1) {
    summary.push('', 'Balances are for the whole v1 shop: import files 4 and 5 once, signed in to the branch that collects and pays them.');
  }
  summary.push('', 'Import the files on the Import / Export page in their numbered order. Each is checked before anything is saved.');
  return { files: files.filter((f) => f.rows > 0), summary };
}
