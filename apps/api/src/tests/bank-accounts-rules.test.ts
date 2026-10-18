/**
 * bank-accounts-rules.test.ts
 *
 * Bank accounts and reconciliation (#21, step 4), owner decisions 1a–3a:
 * - 1a: the system's bank movements and the bank's statement lines are kept
 *   apart; a line is matched to one movement (on import when exactly one fits,
 *   or by hand), and both are cleared; an unmatch reopens both;
 * - 2a: with the module on, a bank payment names an active account of the
 *   branch and is queued for reconciliation; with it off, none is needed;
 * - 3a: ETB accounts, each number registered once, fixed once money moved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanBankAccounts } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

process.env.FEATURE_BANK_ACCOUNTS = 'true';

const STAFF_PREFIX = 'bank_rule_test_';
const BRANCH_PREFIX = 'Bank Rule Test ';

describe('Bank accounts and reconciliation', () => {
  let branchA: number;
  let branchB: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let managerA: string;
  let managerB: string;
  let financeA: string;
  let salesA: string;
  let accountA: number;
  let accountB: number;
  let number = 7_000_000;
  const today = new Date().toISOString().slice(0, 10);

  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => api().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const accounts = (branchId: number, path = '') => `/api/v1/branches/${branchId}/bank-accounts${path}`;
  const newAccount = async (token: string, branchId: number, body: object = {}) =>
    as(token).post(accounts(branchId), { accountName: 'Account', bankName: 'CBE', accountNumber: String(number++), ...body });

  const sell = (payments: object[]) =>
    as(salesA).post('/api/v1/pos/transactions', { locationId, items: [{ bookId, quantity: 1 }], payments });
  const entriesOf = async (account: number) =>
    (await db.query(`SELECT source_type, direction, amount::float AS amount, status FROM bank_reconciliation WHERE bank_account_id = $1 ORDER BY id`, [account])).rows;

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const b of (await db.query(branches)).rows) await cleanBankAccounts(b.id);
    for (const statement of [
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    managerA = (await createTestStaff({ username: `${STAFF_PREFIX}mgra`, role: 'Manager', branchId: branchA })).token;
    managerB = (await createTestStaff({ username: `${STAFF_PREFIX}mgrb`, role: 'Manager', branchId: branchB })).token;
    financeA = (await createTestStaff({ username: `${STAFF_PREFIX}fina`, role: 'Finance_Officer', branchId: branchA })).token;
    salesA = (await createTestStaff({ username: `${STAFF_PREFIX}salesa`, role: 'Sales', branchId: branchA })).token;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Bank Rule Loc', true) RETURNING id`,
      [branchA],
    )).rows[0].id;
    const book = (await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`)).rows[0];
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 500, 5, 0)`, [bookId, locationId]);
    accountA = (await newAccount(managerA, branchA, { accountName: 'A main' })).body.id;
    accountB = (await newAccount(managerB, branchB, { accountName: 'B main' })).body.id;
  });

  afterAll(cleanUp);

  describe('branch scope', () => {
    it("cannot read, rename or deactivate another branch's account through its own branch URL (was: 200, renamed, 200)", async () => {
      expect((await as(managerA).get(accounts(branchA, `/${accountB}`))).status).toBe(404);
      expect((await as(managerA).put(accounts(branchA, `/${accountB}`), { accountName: 'hijacked' })).status).toBe(404);
      expect((await as(managerA).post(accounts(branchA, `/${accountB}/deactivate`))).status).toBe(404);
      const { rows } = await db.query(`SELECT account_name, is_active FROM bank_accounts WHERE id = $1`, [accountB]);
      expect(rows[0]).toEqual({ account_name: 'B main', is_active: true });
    });

    it("cannot import into, list or match another branch's statement (was: 201, 200, 200)", async () => {
      const line = { statementDate: today, amount: 10, direction: 'in' };
      expect((await as(managerA).post(accounts(branchA, `/${accountB}/statement-lines`), { lines: [line] })).status).toBe(404);
      expect((await as(managerA).get(accounts(branchA, `/${accountB}/statement-lines`))).status).toBe(404);
      expect((await as(managerA).get(accounts(branchA, `/${accountB}/entries`))).status).toBe(404);
      expect((await db.query(`SELECT 1 FROM bank_statement_lines WHERE bank_account_id = $1`, [accountB])).rows).toHaveLength(0);
    });

    it('validates paging (was: 500 for ?page=abc)', async () => {
      expect((await as(managerA).get(accounts(branchA, '?page=abc'))).status).toBe(400);
      expect((await as(managerA).get(accounts(branchA, `/${accountA}/statement-lines?page=abc`))).status).toBe(400);
    });
  });

  describe('bank payments (owner decision 2a)', () => {
    it('needs an account for a POS bank payment while the module is on', async () => {
      const res = await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price }]);
      expect(res.status).toBe(400);
    });

    it("records a POS bank payment on the branch's account, and its void as money out (was: account id in the text reference)", async () => {
      const sale = await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: accountA }]);
      expect(sale.status).toBe(201);
      expect(sale.body.payments[0].bankAccountId).toBe(accountA);
      expect(await entriesOf(accountA)).toEqual([{ source_type: 'pos_payment', direction: 'in', amount: price, status: 'uncleared' }]);

      const voided = await as(managerA).post(`/api/v1/pos/transactions/${sale.body.id}/void`);
      expect(voided.status).toBe(200);
      expect((await entriesOf(accountA)).map((e) => [e.source_type, e.direction])).toEqual([
        ['pos_payment', 'in'],
        ['pos_void', 'out'],
      ]);
      await db.query(`DELETE FROM bank_reconciliation WHERE bank_account_id = $1`, [accountA]);
    });

    it("refuses another branch's or an inactive account", async () => {
      expect((await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: accountB }])).body.error).toBe('INVALID_BANK_ACCOUNT');
      const inactive = (await newAccount(managerA, branchA)).body.id;
      await as(managerA).post(accounts(branchA, `/${inactive}/deactivate`));
      expect((await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: inactive }])).body.error).toBe('INVALID_BANK_ACCOUNT');
    });
  });

  describe('reconciliation (owner decision 1a)', () => {
    let account: number;
    const linesUrl = (path = '') => accounts(branchA, `/${account}/statement-lines${path}`);

    beforeAll(async () => {
      account = (await newAccount(managerA, branchA, { accountName: 'Recon' })).body.id;
    });

    it('matches a statement line to the payment it stands for, clearing both (was: every line unmatched, the payment never cleared)', async () => {
      const sale = await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: account }]);
      expect(sale.status).toBe(201);

      const res = await as(financeA).post(linesUrl(), { lines: [{ statementDate: today, amount: price, direction: 'in', reference: 'STMT-1' }] });
      expect(res.body).toEqual({ imported: 1, matched: 1, duplicates: 0 });
      expect((await entriesOf(account)).map((e) => e.status)).toEqual(['cleared']);
      const lines = (await as(financeA).get(linesUrl())).body.items;
      expect(lines[0].entryId).not.toBeNull();
    });

    it('unmatches a mistaken match, reopening both, and matches by hand', async () => {
      const line = (await as(financeA).get(linesUrl())).body.items[0];
      expect((await as(financeA).post(linesUrl(`/${line.id}/unmatch`))).status).toBe(200);
      expect((await entriesOf(account)).map((e) => e.status)).toEqual(['uncleared']);

      const entry = (await as(financeA).get(accounts(branchA, `/${account}/entries?status=uncleared`))).body.items[0];
      expect((await as(financeA).post(linesUrl(`/${line.id}/match`), { entryId: entry.id })).status).toBe(200);
      expect((await entriesOf(account)).map((e) => e.status)).toEqual(['cleared']);

      const audits = await db.query(`SELECT meta->>'action' AS action FROM audit_logs WHERE entity_type = 'bank_statement_line' AND entity_id = $1 ORDER BY id`, [line.id]);
      expect(audits.rows.map((r) => r.action)).toEqual(['unmatch', 'match']);
    });

    it('skips a line whose bank reference was imported before (was: doubled)', async () => {
      const res = await as(financeA).post(linesUrl(), { lines: [{ statementDate: today, amount: price, direction: 'in', reference: 'STMT-1' }] });
      expect(res.body).toEqual({ imported: 0, matched: 0, duplicates: 1 });
    });

    it('refuses a match to a movement that does not exist, or that does not fit (was: cleared against payment 99999999)', async () => {
      const imported = await as(financeA).post(linesUrl(), { lines: [{ statementDate: today, amount: 1, direction: 'out', reference: 'STMT-ODD' }] });
      expect(imported.body.matched).toBe(0);
      const line = (await as(financeA).get(linesUrl('?matched=false'))).body.items.find((l: { reference: string }) => l.reference === 'STMT-ODD');

      expect((await as(financeA).post(linesUrl(`/${line.id}/match`), { entryId: '99999999' })).status).toBe(404);

      await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: account }]);
      const open = (await as(financeA).get(accounts(branchA, `/${account}/entries?status=uncleared`))).body.items[0];
      const mismatch = await as(financeA).post(linesUrl(`/${line.id}/match`), { entryId: open.id });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error).toBe('MATCH_MISMATCH');
    });

    it('leaves a line open when more than one payment fits', async () => {
      await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: account }]);
      const res = await as(financeA).post(linesUrl(), { lines: [{ statementDate: today, amount: price, direction: 'in', reference: 'STMT-TWO' }] });
      expect(res.body.matched).toBe(0);
    });
  });

  describe('account rules (owner decision 3a)', () => {
    it('registers an account number once, however it is written (was: twice)', async () => {
      expect((await newAccount(managerA, branchA, { accountNumber: '1000-2000-3000' })).status).toBe(201);
      const again = await newAccount(managerB, branchB, { accountNumber: '1000 2000 3000' });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('DUPLICATE_ACCOUNT_NUMBER');
    });

    it('takes ETB accounts only', async () => {
      expect((await newAccount(managerA, branchA, { currency: 'USD' })).status).toBe(400);
    });

    it('keeps the number once money has moved, while the name can change', async () => {
      const id = (await newAccount(managerA, branchA)).body.id;
      expect((await as(managerA).put(accounts(branchA, `/${id}`), { accountNumber: '414141' })).status).toBe(200);
      expect((await sell([{ method: 'bank', payerBank: 'CBE', reference: 'FT-TEST', amount: price, bankAccountId: id }])).status).toBe(201);

      const res = await as(managerA).put(accounts(branchA, `/${id}`), { accountNumber: '424242' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('BANK_ACCOUNT_IN_USE');
      expect((await as(managerA).put(accounts(branchA, `/${id}`), { accountName: 'Renamed' })).body.accountName).toBe('Renamed');
    });

    it('audits a repeated deactivation once, and reactivates (was: audited twice, no way back)', async () => {
      const id = (await newAccount(managerA, branchA)).body.id;
      await as(managerA).post(accounts(branchA, `/${id}/deactivate`));
      await as(managerA).post(accounts(branchA, `/${id}/deactivate`));
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'bank_account' AND entity_id = $1 AND action = 'INACTIVATE'`, [String(id)]);
      expect(rows[0].n).toBe(1);
      expect((await as(managerA).post(accounts(branchA, `/${id}/reactivate`))).body.isActive).toBe(true);
    });
  });
});
