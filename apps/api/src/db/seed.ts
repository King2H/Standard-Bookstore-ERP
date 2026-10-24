/**
 * ensureSeedData — runs at every server startup after migrations.
 *
 * Guarantees the minimum data required for the app to work exists in the DB.
 * All statements are insert-only (ON CONFLICT DO NOTHING), so running this on
 * an already-populated database never overwrites data an operator has changed
 * (passwords, active flags, branch names).
 *
 * This is intentionally NOT a migration — migrations can be skipped if they
 * were already recorded as run. Startup seed always executes.
 */
import { db } from './index.js';
import { runInTenant } from './tenantContext.js';

// bcrypt hash (cost 12) of the documented default password 'Admin@1234'.
export const DEFAULT_ADMIN_PASSWORD_HASH =
  '$2b$12$eMHKfE9UzGhT5GvCtB6w4.6/WRde0aH6DzJzluzr0Vzp6KPVA64NK';

/** The tenant every install starts with, an on-premise install's only one (#13). */
export const DEFAULT_TENANT_ID = 1;

/** The seed data belongs to the default tenant. */
export function ensureSeedData(): Promise<void> {
  return runInTenant(DEFAULT_TENANT_ID, seedDefaultTenant);
}

async function seedDefaultTenant(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Main Branch ────────────────────────────────────────────────────────
    // No made-up address or phone: the shop enters its own (owner decision 4a).
    await client.query(`
      INSERT INTO branches (id, name, address, contact_info, operating_hours, is_active)
      VALUES (
        1,
        'Main Branch',
        '',
        '{}',
        '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00","sat":"10:00-16:00","sun":"closed"}',
        true
      )
      ON CONFLICT (id) DO NOTHING
    `);

    // ── 2. Staff accounts ─────────────────────────────────────────────────────
    // Created only on a fresh install. Existing rows are never touched: an
    // upsert here used to reset both accounts to the default password and
    // reactivate them on every restart.
    await client.query(
      `INSERT INTO staff (id, username, password_hash, full_name, is_active)
       VALUES
         (1, 'superadmin', $1, 'Super Admin', true),
         (2, 'admin',      $1, 'Admin User',  true)
       ON CONFLICT (id) DO NOTHING`,
      [DEFAULT_ADMIN_PASSWORD_HASH],
    );

    // Any seeded account still on the published default password must change
    // it at next login. Covers fresh installs and databases where the old
    // upsert already reset the password.
    await client.query(
      `UPDATE staff SET must_change_password = true
       WHERE id IN (1, 2) AND password_hash = $1 AND must_change_password = false`,
      [DEFAULT_ADMIN_PASSWORD_HASH],
    );

    // Set is_all_branches for superadmin and admin — best-effort (column may not
    // exist on older DBs that haven't run migration 33/34 yet).
    try {
      await client.query(`
        UPDATE staff SET is_all_branches = true
        WHERE id IN (1, 2)
      `);
    } catch {
      // Column doesn't exist yet — migration 33/34 will add it on next startup
    }

    // ── 3. Role assignments ───────────────────────────────────────────────────
    // Assign superadmin and admin to ALL active branches so they're not locked
    // to just the default Main Branch. Uses INSERT ... SELECT to pick up any
    // branches created after the initial seed.
    await client.query(`
      INSERT INTO staff_branch_roles (staff_id, branch_id, role)
      SELECT 1, id, 'Super_Admin' FROM branches WHERE is_active = true
      ON CONFLICT (staff_id, branch_id, role) DO NOTHING
    `);
    await client.query(`
      INSERT INTO staff_branch_roles (staff_id, branch_id, role)
      SELECT 2, id, 'Admin' FROM branches WHERE is_active = true
      ON CONFLICT (staff_id, branch_id, role) DO NOTHING
    `);

    // ── 4. Advance sequences past seeded IDs ──────────────────────────────────
    // Only ever forward: rewinding to MAX(id) after the newest row was deleted
    // would give its id to the next row, which then inherits the old row's
    // audit log, notifications and other references.
    await client.query(`
      SELECT setval('branches_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM branches), 1, (SELECT last_value FROM branches_id_seq)));
      SELECT setval('staff_id_seq',    GREATEST((SELECT COALESCE(MAX(id), 2) FROM staff),    2, (SELECT last_value FROM staff_id_seq)));
    `);

    // ── 5. Default location for Main Branch ───────────────────────────────────
    await client.query(`
      INSERT INTO locations (branch_id, name, is_default_fulfillment)
      SELECT id, 'Main Floor', true
      FROM   branches
      WHERE  id = 1
      ON CONFLICT (branch_id, name) DO NOTHING
    `);

    // ── 6. No demo data ───────────────────────────────────────────────────────
    // A fresh install starts with an empty catalog, no suppliers and no
    // customers; `npm run db:demo` loads the demo set on request (owner
    // decision 1a). The seed used to insert the demo books on every start, so a
    // book deleted by the shop came back.

    // ── 7. System config defaults ─────────────────────────────────────────────
    const configDefaults: Array<[string, string]> = [
      ['base_currency',                    '"ETB"'],
      // tax_rate omitted — taxation disabled for this phase
      ['fiscal_year_start_month',          '1'],
      ['max_line_discount_pct',            '{"Sales":10,"Manager":25,"Admin":50}'],
      ['max_transaction_discount_pct',     '20'],
      ['discount_approval_threshold_pct',  '15'],
      ['reorder_point_default',            '5'],
      ['allow_negative_stock',             'false'],
      ['po_approval_threshold',            '1000.00'],
      ['default_supplier_lead_time_days',  '7'],
      ['return_window_days',               '30'],
      ['max_return_value_without_auth',    '500.00'],
      ['refund_method_after_window',       '"any"'],
      ['loyalty_accrual_rate',             '0.01'],
      ['loyalty_redemption_rate',          '1.0'],
      ['loyalty_min_transaction_amount',   '0.00'],
      ['exchange_cash_adjustment_allowed', 'true'],
      ['notification_prefs',               '{}'],
    ];

    for (const [key, value] of configDefaults) {
      await client.query(
        `INSERT INTO system_config (key, value, updated_by)
         VALUES ($1, $2::jsonb, 1)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [key, value],
      );
    }

    // ── 8. Backfill store_credit_history for existing POS credit/partial sales ─
    // Ensures historical credit transactions are visible in the customer's
    // Store Credit tab. Idempotent — uses ON CONFLICT DO NOTHING on a unique
    // combination of customer_id + ref_id + ref_type.
    try {
      await client.query(`
        INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
        SELECT
          t.customer_id,
          'pos_credit_sale'       AS ref_type,
          t.transaction_number    AS ref_id,
          t.amount_due            AS amount,
          'debit'                 AS direction
        FROM transactions t
        WHERE t.customer_id IS NOT NULL
          AND t.payment_status IN ('credit', 'partial')
          AND t.amount_due > 0
          AND NOT EXISTS (
            SELECT 1 FROM store_credit_history sch
            WHERE sch.customer_id = t.customer_id
              AND sch.ref_id = t.transaction_number
              AND sch.ref_type = 'pos_credit_sale'
          )
      `);
    } catch (backfillErr) {
      // Non-fatal — transactions table may not exist yet on fresh installs
      const msg = (backfillErr as { message?: string }).message ?? '';
      if (!msg.includes('transactions') && !msg.includes('store_credit_history')) {
        throw backfillErr;
      }
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ level: 'info', msg: 'Seed data verified/applied' }));
  } catch (err) {
    await client.query('ROLLBACK');
    // Log but don't crash — the app can still run if seed partially exists
    console.error(JSON.stringify({ level: 'error', msg: 'Seed data error', error: (err as Error).message }));
  } finally {
    client.release();
  }
}
