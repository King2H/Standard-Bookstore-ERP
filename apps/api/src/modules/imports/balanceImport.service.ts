import {
  CUSTOMER_BALANCE_IMPORT_COLUMNS, Money, SUPPLIER_BALANCE_IMPORT_COLUMNS,
  type ImportReport, type ImportRequest, type ImportResult, type ImportRowError,
} from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { buildCsv, type CsvColumnDef } from '../../lib/csvBuilder.js';
import { readCsv } from '../../lib/csvRead.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError } from '../../lib/errors.js';
import { piiLookupHash } from '../../lib/piiEncryption.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import type { Actor } from '../catalog/catalog.types.js';
import { addPoints, moveStoreCredit } from '../customer/customer.repository.js';
import { insert as insertReceivable } from '../receivables/receivables.repository.js';
import { insert as insertSupplier } from '../supplier/supplier.repository.js';
import {
  balanceDecision, readCustomerBalanceHeader, readCustomerBalanceRow, readSupplierBalanceHeader, readSupplierBalanceRow, SALES_STARTED,
  type CustomerBalanceRow, type SupplierBalanceRow,
} from './balanceImport.policy.js';
import { reportOf } from './importFile.policy.js';
import * as repo from './imports.repository.js';

/**
 * Opening balances (#246 part 3, owner decisions 2a and 1a–3a): what each
 * customer owed, held in store credit and earned in points, and what the shop
 * owed each supplier, when it started on the system. Only before its first
 * sale; once: the same balance again changes nothing, another is refused.
 */

const NONE = { toCreate: 0, toUpdate: 0, unchanged: 0 };

function audit(tx: Queryable, actor: Actor, action: string, entityType: 'customer' | 'supplier' | 'purchase_order' | 'data_import', entityId: string | number, meta: Record<string, unknown>) {
  return insertAuditEntry(tx, { staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action, entityType, entityId, meta });
}

function rejectInvalid(report: ImportReport, onlyValid: boolean): number {
  const invalid = report.errors.length + report.moreErrors;
  if (invalid > 0 && !onlyValid) {
    throw new BusinessError('IMPORT_HAS_ERRORS', `${invalid} row(s) of the file cannot be imported: nothing was saved`, { report });
  }
  return invalid;
}

// ── Customers ──────────────────────────────────────────────────────────────

interface PlannedCustomer {
  row: CustomerBalanceRow;
  customer: repo.CustomerRef;
  owed: boolean;
  storeCredit: boolean;
  points: boolean;
}

async function planCustomerBalances(q: Queryable, csv: string): Promise<{ report: ImportReport; rows: PlannedCustomer[] }> {
  const file = readCsv(csv);
  const errors: ImportRowError[] = [];
  const header = readCustomerBalanceHeader(file.header);
  if (header.errors.length > 0 || await repo.hasSales(q)) {
    errors.push({ line: 1, messages: header.errors.length > 0 ? header.errors : [SALES_STARTED] });
    return { report: reportOf('customer-balances', file.rows.length, 0, NONE, errors), rows: [] };
  }
  const read: CustomerBalanceRow[] = [];
  for (const { line, cells } of file.rows) {
    const { row, messages } = readCustomerBalanceRow(cells, header.index, line, file.delimiter === ';');
    if (row) read.push(row); else errors.push({ line, messages });
  }
  const lookups = (field: 'phone' | 'email') => read.map((r) => piiLookupHash(r[field])).filter((h): h is string => h !== null);
  const known = await repo.customersByKeys(q, read.map((r) => r.code).filter((c): c is string => !!c), lookups('phone'), lookups('email'));
  const existing = await repo.openingCustomerBalances(q, known.map((c) => c.id));

  const seen = new Map<number, number>();
  const rows: PlannedCustomer[] = [];
  const counts = { ...NONE };
  for (const row of read) {
    const phone = piiLookupHash(row.phone);
    const email = piiLookupHash(row.email);
    const customer = row.code
      ? known.find((c) => c.code.toLowerCase() === row.code!.toLowerCase())
      : known.find((c) => phone !== null && c.phoneLookup === phone) ?? known.find((c) => email !== null && c.emailLookup === email);
    if (!customer) {
      const by = row.code ? `code ${row.code}` : row.phone ? `phone ${row.phone}` : `email ${row.email}`;
      errors.push({ line: row.line, messages: [`No customer with ${by}: import the customers first`] });
      continue;
    }
    if (seen.has(customer.id)) { errors.push({ line: row.line, messages: [`The same customer as line ${seen.get(customer.id)}`] }); continue; }
    seen.set(customer.id, row.line);

    const decisions = {
      owed: balanceDecision(row.owed, existing.owed.get(customer.id)),
      storeCredit: balanceDecision(row.storeCredit, existing.storeCredit.get(customer.id)),
      points: balanceDecision(row.points, existing.points.get(customer.id)),
    };
    const messages: string[] = [];
    if (decisions.owed === 'different') messages.push(`${customer.code} already has an opening balance owed of ${Money.of(existing.owed.get(customer.id)!).toFixed(2)}`);
    if (decisions.storeCredit === 'different') messages.push(`${customer.code} already has an opening store credit of ${Money.of(existing.storeCredit.get(customer.id)!).toFixed(2)}`);
    if (decisions.points === 'different') messages.push(`${customer.code} already has ${existing.points.get(customer.id)} opening loyalty points`);
    if (messages.length > 0) { errors.push({ line: row.line, messages }); continue; }

    const planned = { row, customer, owed: decisions.owed === 'new', storeCredit: decisions.storeCredit === 'new', points: decisions.points === 'new' };
    rows.push(planned);
    if (planned.owed || planned.storeCredit || planned.points) counts.toCreate += 1; else counts.unchanged += 1;
  }
  return { report: reportOf('customer-balances', file.rows.length, rows.length, counts, errors), rows };
}

export async function checkCustomerBalances(req: ImportRequest): Promise<ImportReport> {
  return (await planCustomerBalances(kysely, req.csv)).report;
}

export async function importCustomerBalances(actor: Actor, req: ImportRequest): Promise<ImportResult> {
  return withTransaction({}, async (tx) => {
    const plan = await planCustomerBalances(tx, req.csv);
    if (plan.report.errors.some((e) => e.line === 1)) {
      throw new BusinessError('IMPORT_HAS_ERRORS', plan.report.errors[0].messages[0], { report: plan.report });
    }
    const invalid = rejectInvalid(plan.report, req.onlyValid);
    const note = `Opening balance (import${req.fileName ? `: ${req.fileName}` : ''})`;
    let created = 0;
    for (const { row, customer, owed, storeCredit, points } of plan.rows) {
      if (!owed && !storeCredit && !points) continue;
      if (owed) {
        await insertReceivable(tx, {
          sourceType: 'opening_balance', sourceRefId: customer.code, sourceEntityId: customer.id, customerId: customer.id,
          branchId: actor.branchId, originalAmount: Money.of(row.owed!), dueDate: row.dueDate ?? null, notes: note,
        });
      }
      if (storeCredit) await moveStoreCredit(tx, customer.id, Money.of(row.storeCredit!), { direction: 'credit', refType: 'opening_balance', refId: null });
      if (points) await addPoints(tx, customer.id, row.points!, { reason: 'OPENING_BALANCE', transactionRef: null });
      await audit(tx, actor, 'OPENING_BALANCE', 'customer', customer.id, {
        customerCode: customer.code, owed: owed ? row.owed : null, dueDate: owed ? row.dueDate : null,
        storeCredit: storeCredit ? row.storeCredit : null, points: points ? row.points : null, import: req.fileName ?? null,
      });
      created += 1;
    }
    await audit(tx, actor, 'IMPORT', 'data_import', 'customer-balances', {
      kind: 'customer-balances', fileName: req.fileName ?? null, rows: plan.report.rows, created, updated: 0, skipped: invalid,
    });
    return { ...plan.report, created, updated: 0, skipped: invalid };
  });
}

// ── Suppliers ──────────────────────────────────────────────────────────────

interface PlannedSupplier {
  row: SupplierBalanceRow;
  supplierId: number | undefined;
  create: boolean;
}

async function planSupplierBalances(q: Queryable, csv: string): Promise<{ report: ImportReport; rows: PlannedSupplier[] }> {
  const file = readCsv(csv);
  const errors: ImportRowError[] = [];
  const header = readSupplierBalanceHeader(file.header);
  if (header.errors.length > 0 || await repo.hasSales(q)) {
    errors.push({ line: 1, messages: header.errors.length > 0 ? header.errors : [SALES_STARTED] });
    return { report: reportOf('supplier-balances', file.rows.length, 0, NONE, errors), rows: [] };
  }
  const suppliers = await repo.suppliersByName(q);
  const seen = new Map<string, number>();
  const rows: PlannedSupplier[] = [];
  const counts = { ...NONE };
  const newSuppliers: string[] = [];
  for (const { line, cells } of file.rows) {
    const { row, messages } = readSupplierBalanceRow(cells, header.index, line, file.delimiter === ';');
    if (!row) { errors.push({ line, messages }); continue; }
    const key = row.supplier.toLowerCase();
    if (seen.has(key)) { errors.push({ line, messages: [`The same supplier as line ${seen.get(key)}`] }); continue; }
    seen.set(key, line);
    const known = suppliers.get(key);
    const decision = balanceDecision(row.owed, known?.openingOwed ?? undefined);
    if (decision === 'different') {
      errors.push({ line, messages: [`${known!.name} already has an opening balance owed of ${Money.of(known!.openingOwed!).toFixed(2)}`] });
      continue;
    }
    if (!known) newSuppliers.push(row.supplier);
    rows.push({ row, supplierId: known?.id, create: decision === 'new' });
    if (decision === 'new') counts.toCreate += 1; else counts.unchanged += 1;
  }
  const report = reportOf('supplier-balances', file.rows.length, rows.length, counts, errors, [],
    { authors: [], categories: [], publishers: [], suppliers: newSuppliers });
  return { report, rows };
}

export async function checkSupplierBalances(req: ImportRequest): Promise<ImportReport> {
  return (await planSupplierBalances(kysely, req.csv)).report;
}

export async function importSupplierBalances(actor: Actor, req: ImportRequest): Promise<ImportResult> {
  return withTransaction({}, async (tx) => {
    const plan = await planSupplierBalances(tx, req.csv);
    if (plan.report.errors.some((e) => e.line === 1)) {
      throw new BusinessError('IMPORT_HAS_ERRORS', plan.report.errors[0].messages[0], { report: plan.report });
    }
    const invalid = rejectInvalid(plan.report, req.onlyValid);
    const note = `Opening balance (import${req.fileName ? `: ${req.fileName}` : ''})`;
    let created = 0;
    for (const { row, supplierId, create } of plan.rows) {
      if (!create) continue;
      let id = supplierId;
      if (id === undefined) {
        const contactInfo = { ...(row.phone ? { phone: row.phone } : {}), ...(row.email ? { email: row.email } : {}) };
        id = await insertSupplier(tx, { name: row.supplier, contactInfo, leadTimeDays: 7, pricingTerms: null, supplierType: 'external', publisherId: null });
        await audit(tx, actor, 'CREATE', 'supplier', id, { name: row.supplier, import: req.fileName ?? null });
      }
      const poNumber = await nextDailyNumber(tx, 'OPB');
      const poId = await repo.insertOpeningPurchaseOrder(tx, { poNumber, supplierId: id, branchId: actor.branchId, amount: row.owed, createdBy: actor.staffId, notes: note });
      await audit(tx, actor, 'OPENING_BALANCE', 'purchase_order', poId, { poNumber, supplier: row.supplier, owed: row.owed, import: req.fileName ?? null });
      created += 1;
    }
    await audit(tx, actor, 'IMPORT', 'data_import', 'supplier-balances', {
      kind: 'supplier-balances', fileName: req.fileName ?? null, rows: plan.report.rows, created, updated: 0, skipped: invalid,
    });
    return { ...plan.report, created, updated: 0, skipped: invalid };
  });
}

// ── Templates ──────────────────────────────────────────────────────────────

const columns = (list: readonly string[]): CsvColumnDef[] => list.map((c) => ({ key: c, header: c, type: 'string' }));

export function customerBalanceTemplate(): string {
  return buildCsv([{ Code: 'CUS-0001', Phone: '', Email: '', 'Amount Owed': '1500.00', 'Due Date': '2026-12-31', 'Store Credit': '0', 'Loyalty Points': '120' }],
    columns(CUSTOMER_BALANCE_IMPORT_COLUMNS));
}

export function supplierBalanceTemplate(): string {
  return buildCsv([{ Supplier: 'Example Distributor', Phone: '+251911000000', Email: '', 'Amount Owed': '25000.00' }], columns(SUPPLIER_BALANCE_IMPORT_COLUMNS));
}
