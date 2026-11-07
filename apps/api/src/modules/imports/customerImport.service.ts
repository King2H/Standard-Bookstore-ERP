import { CUSTOMER_IMPORT_COLUMNS, type ImportReport, type ImportRequest, type ImportResult, type ImportRowError, type UpdateCustomerRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { buildCsv, type CsvColumnDef } from '../../lib/csvBuilder.js';
import { readCsv } from '../../lib/csvRead.js';
import { BusinessError } from '../../lib/errors.js';
import { piiLookupHash } from '../../lib/piiEncryption.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import type { Actor } from '../catalog/catalog.types.js';
import { allCustomers } from '../customer/customer.repository.js';
import { createCustomerWith, updateCustomerWith } from '../customer/customer.service.js';
import { readCustomerHeader, readCustomerRow, type CustomerRow } from './customerImport.policy.js';
import { reportOf } from './importFile.policy.js';
import * as repo from './imports.repository.js';

/**
 * The customer import (#246): a customer is found again by code, else phone,
 * else email (phone and email through their lookup hash: they are stored
 * encrypted, #90); checked first, saved in one transaction.
 */

interface PlannedRow {
  row: CustomerRow;
  existing?: repo.CustomerRef;
  change: UpdateCustomerRequest;
}

/** What a row changes on its customer: the cells given that differ. */
function changesOf(existing: repo.CustomerRef, row: CustomerRow): UpdateCustomerRequest {
  const change: UpdateCustomerRequest = {};
  if (row.name && row.name !== existing.name) change.fullName = row.name;
  if (row.phone && piiLookupHash(row.phone) !== existing.phoneLookup) change.phone = row.phone;
  if (row.email && piiLookupHash(row.email) !== existing.emailLookup) change.email = row.email;
  if (row.address && row.address !== existing.address) change.address = row.address;
  if (row.city && row.city !== existing.city) change.city = row.city;
  return change;
}

async function planCustomers(q: Queryable, csv: string): Promise<{ report: ImportReport; rows: PlannedRow[] }> {
  const file = readCsv(csv);
  const errors: ImportRowError[] = [];
  const header = readCustomerHeader(file.header);
  if (header.errors.length > 0) {
    errors.push({ line: 1, messages: header.errors });
    return { report: reportOf('customers', file.rows.length, 0, { toCreate: 0, toUpdate: 0, unchanged: 0 }, errors), rows: [] };
  }
  const read: CustomerRow[] = [];
  for (const { line, cells } of file.rows) {
    const { row, messages } = readCustomerRow(cells, header.index, line);
    if (row) read.push(row); else errors.push({ line, messages });
  }
  const lookups = (field: 'phone' | 'email') => read.map((r) => piiLookupHash(r[field])).filter((h): h is string => h !== null);
  const known = await repo.customersByKeys(q, read.map((r) => r.code).filter((c): c is string => !!c), lookups('phone'), lookups('email'));
  const byCode = new Map(known.map((c) => [c.code.toLowerCase(), c]));
  const byPhone = new Map(known.filter((c) => c.phoneLookup).map((c) => [c.phoneLookup!, c]));
  const byEmail = new Map(known.filter((c) => c.emailLookup).map((c) => [c.emailLookup!, c]));

  const seen = new Map<string, number>();
  const once = (key: string | null, what: string, line: number, messages: string[]) => {
    if (!key) return;
    if (seen.has(key)) messages.push(`The same ${what} as line ${seen.get(key)}`);
    else seen.set(key, line);
  };
  const rows: PlannedRow[] = [];
  const counts = { toCreate: 0, toUpdate: 0, unchanged: 0 };
  for (const row of read) {
    const messages: string[] = [];
    const phone = piiLookupHash(row.phone);
    const email = piiLookupHash(row.email);
    let existing: repo.CustomerRef | undefined;
    if (row.code) {
      existing = byCode.get(row.code.toLowerCase());
      if (!existing) messages.push(`No customer with code ${row.code}: leave Code empty for a new customer, who gets a code`);
    } else {
      existing = (phone ? byPhone.get(phone) : undefined) ?? (email ? byEmail.get(email) : undefined);
    }
    if (!existing && !row.code && !row.name) messages.push('Name is empty: a new customer needs one');
    once(existing ? `id:${existing.id}` : null, 'customer', row.line, messages);
    once(phone ? `phone:${phone}` : null, 'phone', row.line, messages);
    once(email ? `email:${email}` : null, 'email', row.line, messages);
    const owner = (lookup: string | null, map: Map<string, repo.CustomerRef>) => (lookup ? map.get(lookup) : undefined);
    const phoneOwner = owner(phone, byPhone);
    const emailOwner = owner(email, byEmail);
    if (phoneOwner && phoneOwner.id !== existing?.id) messages.push(`Phone ${row.phone} already belongs to customer ${phoneOwner.code}`);
    if (emailOwner && emailOwner.id !== existing?.id) messages.push(`Email ${row.email} already belongs to customer ${emailOwner.code}`);
    if (messages.length > 0) { errors.push({ line: row.line, messages }); continue; }

    const change = existing ? changesOf(existing, row) : {};
    rows.push({ row, existing, change });
    if (!existing) counts.toCreate += 1;
    else if (Object.keys(change).length > 0) counts.toUpdate += 1;
    else counts.unchanged += 1;
  }
  return { report: reportOf('customers', file.rows.length, rows.length, counts, errors), rows };
}

export async function checkCustomers(req: ImportRequest): Promise<ImportReport> {
  return (await planCustomers(kysely, req.csv)).report;
}

export async function importCustomers(actor: Actor, req: ImportRequest): Promise<ImportResult> {
  return withTransaction({}, async (tx) => {
    const plan = await planCustomers(tx, req.csv);
    const invalid = plan.report.errors.length + plan.report.moreErrors;
    if (invalid > 0 && !req.onlyValid) {
      throw new BusinessError('IMPORT_HAS_ERRORS', `${invalid} row(s) of the file cannot be imported: nothing was saved`, { report: plan.report });
    }
    const meta = { import: req.fileName ?? 'customers' };
    let created = 0;
    let updated = 0;
    for (const { row, existing, change } of plan.rows) {
      if (!existing) {
        await createCustomerWith(tx, actor, { fullName: row.name!, phone: row.phone, email: row.email, address: row.address, city: row.city }, meta);
        created += 1;
      } else if (Object.keys(change).length > 0) {
        await updateCustomerWith(tx, actor, existing.id, change, meta);
        updated += 1;
      }
    }
    await insertAuditEntry(tx, {
      staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action: 'IMPORT', entityType: 'data_import', entityId: 'customers',
      meta: { kind: 'customers', fileName: req.fileName ?? null, rows: plan.report.rows, created, updated, skipped: invalid },
    });
    return { ...plan.report, created, updated, skipped: invalid };
  });
}

const CUSTOMER_CSV: CsvColumnDef[] = CUSTOMER_IMPORT_COLUMNS.map((c) => ({ key: c, header: c, type: 'string' }));

/**
 * Every customer, contacts in clear, as a file the import reads back
 * unchanged. Contacts leave the system here, so the export is audited.
 */
export async function exportCustomers(actor: Actor): Promise<string> {
  return withTransaction({}, async (tx) => {
    const customers = await allCustomers(tx);
    await insertAuditEntry(tx, {
      staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action: 'EXPORT', entityType: 'data_import', entityId: 'customers',
      meta: { kind: 'customers', rows: customers.length },
    });
    return buildCsv(customers.map((c) => ({
      Code: c.customerCode, Name: c.fullName, Phone: c.phone ?? '', Email: c.email ?? '', Address: c.address ?? '', City: c.city ?? '',
    })), CUSTOMER_CSV);
  });
}

export function customerTemplate(): string {
  return buildCsv([{ Code: '', Name: 'Example Customer', Phone: '+251911000000', Email: 'customer@example.com', Address: 'Bole', City: 'Addis Ababa' }], CUSTOMER_CSV);
}
