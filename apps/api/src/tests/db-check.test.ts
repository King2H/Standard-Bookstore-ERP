import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { CHECKS } from '../db/checks/rules.js';
import { exitCode, formatReport, runChecks, type Finding } from '../db/checks/run.js';
import { closeOwnerDb, ownerDb } from './helpers/ownerDb.js';

// #165: the data consistency check. Each rule is shown to catch a row that
// breaks it: the rows are planted in one transaction, as the database owner
// (as `npm run db:check` runs), and rolled back, so nothing is left behind.

const MARK = 'DBCHECK';

describe('Data consistency check', () => {
  let client: pg.PoolClient;
  let findings: Finding[];
  const refs = (id: string) => findings.filter((f) => f.check.id === id && f.tenantId === 1).flatMap((f) => f.examples);

  async function one<T = number>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    return Object.values(rows[0])[0] as T;
  }

  beforeAll(async () => {
    client = await ownerDb().connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '1'`);

    const staffId = await one(`SELECT id FROM staff ORDER BY id LIMIT 1`);
    const [book1, book2, book3] = (await client.query(`SELECT id FROM books ORDER BY id LIMIT 3`)).rows.map((r) => r.id as number);
    const branchId = await one(
      `INSERT INTO branches (name, address, contact_info, operating_hours) VALUES ($1, '123 Test Street', '{}', '{}') RETURNING id`,
      [`${MARK} Branch`],
    );
    const loc = await one(`INSERT INTO locations (branch_id, name) VALUES ($1, $2) RETURNING id`, [branchId, `${MARK} Shelf`]);

    // Stock: on hand 5 while the history last said 3, at cost 0; on hand 4 with no history; damaged below 0.
    await client.query(`INSERT INTO inventory (book_id, location_id, quantity) VALUES ($1, $2, 5)`, [book1, loc]);
    await client.query(
      `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, staff_id) VALUES ($1, $2, 0, 3, 3, 'initial', $3)`,
      [book1, loc, staffId],
    );
    await client.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 4, 2)`, [book2, loc]);
    await client.query(`INSERT INTO inventory (book_id, location_id, quantity, damaged_quantity, average_cost) VALUES ($1, $2, 0, -1, 2)`, [book3, loc]);

    // Orders: a cancelled order still holding a reservation; a "paid" order with no payment; a number ahead of today's counter.
    const today = await one<string>(`SELECT TO_CHAR(CURRENT_DATE, 'YYYYMMDD')`);
    const cancelled = await one(
      `INSERT INTO orders (order_number, branch_id, created_by, status, total, payment_status, currency) VALUES ($1, $2, $3, 'CANCELLED', 10, 'unpaid', 'ETB') RETURNING id`,
      [`${MARK}-CANCELLED`, branchId, staffId],
    );
    await client.query(`INSERT INTO inventory_reservations (order_id, book_id, location_id, quantity, status) VALUES ($1, $2, $3, 1, 'reserved')`, [cancelled, book1, loc]);
    const paidOrder = await one(
      `INSERT INTO orders (order_number, branch_id, created_by, status, total, payment_status, currency) VALUES ($1, $2, $3, 'CONFIRMED', 10, 'paid', 'ETB') RETURNING id`,
      [`ORD-${today}-9999`, branchId, staffId],
    );

    // Receivables: owing more than first owed; settled but still owing.
    const customerId = await one(`INSERT INTO customers (customer_code, full_name) VALUES ('CUS-99999', $1) RETURNING id`, [`${MARK} Customer`]);
    for (const [status, owes, orderId] of [['Pending', 20, cancelled], ['Settled', 5, paidOrder]] as const) {
      await client.query(
        `INSERT INTO receivables (source_type, source_ref_id, source_entity_id, customer_id, branch_id, original_amount, outstanding_amount, status, currency)
         VALUES ('order_credit_sale', $1, $2, $3, $4, 10, $5, $6, 'ETB')`,
        [`${MARK}-${status}`, orderId, customerId, branchId, owes, status],
      );
    }

    // An order cancelled with its payment kept (before #167).
    const keptMoney = await one(
      `INSERT INTO orders (order_number, branch_id, created_by, status, total, payment_status, currency) VALUES ($1, $2, $3, 'CANCELLED', 10, 'paid', 'ETB') RETURNING id`,
      [`${MARK}-KEPT`, branchId, staffId],
    );
    await client.query(
      `INSERT INTO order_payments (payment_reference, order_id, amount, payment_method, processed_by, status, currency) VALUES ($1, $2, 10, 'cash', $3, 'success', 'ETB')`,
      [`${MARK}-PAY`, keptMoney, staffId],
    );

    // Purchase orders: "ordered" with copies received; paid beyond its total.
    const supplierId = await one(`INSERT INTO suppliers (name, contact_info) VALUES ($1, '{}') RETURNING id`, [`${MARK} Supplier`]);
    const poId = await one(
      `INSERT INTO purchase_orders (branch_id, supplier_id, created_by, status, total_amount, currency) VALUES ($1, $2, $3, 'ordered', 50, 'ETB') RETURNING id`,
      [branchId, supplierId, staffId],
    );
    await client.query(`INSERT INTO po_line_items (po_id, book_id, quantity, unit_cost, received_quantity) VALUES ($1, $2, 5, 10, 2)`, [poId, book1]);
    await client.query(
      `INSERT INTO supplier_payments (po_id, branch_id, supplier_id, amount, created_by, payment_method) VALUES ($1, $2, $3, 60, $4, 'cash')`,
      [poId, branchId, supplierId, staffId],
    );

    // Bank: a line matched to an uncleared movement; a cleared movement nobody matched.
    const account = await one(
      `INSERT INTO bank_accounts (branch_id, account_name, bank_name, account_number, currency, account_number_hash)
       VALUES ($1, 'Check', 'Bank', 'enc', 'ETB', $2) RETURNING id`,
      [branchId, `${MARK}-hash`],
    );
    const uncleared = await one(
      `INSERT INTO bank_reconciliation (bank_account_id, amount, direction, source_type, source_id, status) VALUES ($1, 10, 'in', 'order_payment', 'x', 'uncleared') RETURNING id`,
      [account],
    );
    await client.query(
      `INSERT INTO bank_statement_lines (bank_account_id, statement_date, amount, direction, entry_id, matched_at) VALUES ($1, CURRENT_DATE, 10, 'in', $2, now())`,
      [account, uncleared],
    );
    await client.query(
      `INSERT INTO bank_reconciliation (bank_account_id, amount, direction, source_type, source_id, status) VALUES ($1, 20, 'in', 'order_payment', 'y', 'cleared')`,
      [account],
    );

    // Currency: an order kept in a currency that is not the shop's.
    await client.query(
      `INSERT INTO orders (order_number, branch_id, created_by, currency) VALUES ($1, $2, $3, 'XYZ')`,
      [`${MARK}-XYZ`, branchId, staffId],
    );

    // Test data: an account named as the test helpers name theirs.
    await client.query(`INSERT INTO staff (username, password_hash, full_name) VALUES ($1, 'x', 'Test Staff')`, [`${MARK.toLowerCase()}_staff`]);

    findings = await runChecks(client);
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    client.release();
    await closeOwnerDb();
  });

  it.each([
    ['stock.matches-history', /on hand 5, history says 3/],
    ['stock.has-history', /: 4 on hand$/],
    ['stock.damaged-not-negative', /: -1 damaged$/],
    ['stock.valued', /: 5 on hand at cost 0$/],
    ['stock.reservations-open-orders', new RegExp(`^${MARK}-CANCELLED \\(CANCELLED\\)`)],
    ['receivables.within-original', /owes 20\.00 of 10\.00$/],
    ['receivables.status-matches-balance', /\(Settled\): owes 5\.00$/],
    ['orders.payment-status', /-9999: paid, payments say unpaid/],
    ['orders.cancelled-money-returned', new RegExp(`^${MARK}-KEPT: holds 10\\.00 \\(paid 10\\.00, refunded 0\\)$`)],
    ['procurement.status-matches-lines', /\(ordered\): 2 received/],
    ['procurement.paid-within-total', /paid and credited 60\.00 of 50\.00$/],
    ['bank.matched-line-cleared', /is uncleared$/],
    ['bank.cleared-one-line', /: 0 matched lines$/],
    ['numbers.daily-counters-ahead', /^ORD-\d{8}: highest used 9999/],
    ['numbers.customer-counter-ahead', /^CUS: highest used 99999/],
    ['currency.shop', /^orders \d+: XYZ, the shop's is ETB$/],
    ['test-data.branches', new RegExp(`${MARK} Branch$`)],
    ['test-data.staff', /dbcheck_staff$/],
  ])('reports a row that breaks %s', (id, ref) => {
    expect(refs(id).some((r) => ref.test(r)), `${id}: ${JSON.stringify(refs(id))}`).toBe(true);
  });

  it('covers every rule above, and fails the run on an error but not on a warning', () => {
    expect(new Set(findings.map((f) => f.check.id))).toEqual(new Set(CHECKS.map((c) => c.id)));
    expect(exitCode(findings)).toBe(1);
    expect(exitCode(findings.filter((f) => f.check.severity === 'warning'))).toBe(0);
    expect(exitCode([])).toBe(0);
  });

  it('prints every rule, with the broken ones named and counted', () => {
    const report = formatReport(findings.filter((f) => f.check.id === 'stock.valued'));
    expect(report).toContain('  ok     Quantity on hand equals the last movement in the history');
    expect(report).toMatch(/warn {3}Stock on hand has a cost .*\[stock\.valued\]/);
    expect(report).toMatch(/tenant 1: \d+ row\(s\)/);
    expect(report).toMatch(/18 rules: 0 error row\(s\), \d+ warning row\(s\)\.$/);
  });
});
