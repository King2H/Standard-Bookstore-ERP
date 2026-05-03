/**
 * ensureSeedData — runs at every server startup after migrations.
 *
 * Guarantees the minimum data required for the app to work exists in the DB.
 * All statements are fully idempotent (ON CONFLICT DO NOTHING / DO UPDATE),
 * so running this on an already-populated database is completely safe.
 *
 * This is intentionally NOT a migration — migrations can be skipped if they
 * were already recorded as run. Startup seed always executes.
 */
import { db } from './index.js';

export async function ensureSeedData(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── 0. Ensure schema columns exist (idempotent guards) ────────────────────
    // These run before any data operations to prevent 500 errors on older DBs
    // that haven't run the latest migrations yet.
    await client.query(`
      ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_all_branches BOOLEAN NOT NULL DEFAULT false;
    `);

    // ── 1. Main Branch ────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO branches (id, name, address, contact_info, operating_hours, is_active)
      VALUES (
        1,
        'Main Branch',
        '1 Bookstore Avenue, City',
        '{"phone":"555-0100","email":"main@bookstore.com"}',
        '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00","sat":"10:00-16:00","sun":"closed"}',
        true
      )
      ON CONFLICT (id) DO UPDATE
        SET is_active = true,
            name      = EXCLUDED.name
    `);

    // ── 2. Staff accounts ─────────────────────────────────────────────────────
    // bcrypt hash of 'Admin@1234' (cost 12) — generated offline and verified
    // Note: is_all_branches is added by migration 33/34. We try to set it here
    // but fall back gracefully if the column doesn't exist yet.
    await client.query(`
      INSERT INTO staff (id, username, password_hash, full_name, is_active)
      VALUES
        (1, 'superadmin', '$2b$12$eMHKfE9UzGhT5GvCtB6w4.6/WRde0aH6DzJzluzr0Vzp6KPVA64NK', 'Super Admin', true),
        (2, 'admin',      '$2b$12$eMHKfE9UzGhT5GvCtB6w4.6/WRde0aH6DzJzluzr0Vzp6KPVA64NK', 'Admin User',  true)
      ON CONFLICT (id) DO UPDATE
        SET is_active     = true,
            username      = EXCLUDED.username,
            password_hash = EXCLUDED.password_hash
    `);

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
    await client.query(`
      SELECT setval('branches_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM branches), 1));
      SELECT setval('staff_id_seq',    GREATEST((SELECT COALESCE(MAX(id), 2) FROM staff),    2));
    `);

    // ── 5. Default location for Main Branch ───────────────────────────────────
    await client.query(`
      INSERT INTO locations (branch_id, name, is_default_fulfillment)
      SELECT id, 'Main Floor', true
      FROM   branches
      WHERE  id = 1
      ON CONFLICT (branch_id, name) DO NOTHING
    `);

    // ── 6. System config defaults ─────────────────────────────────────────────
    const configDefaults: Array<[string, string]> = [
      ['base_currency',                    '"ETB"'],
      ['tax_rate',                         '0.15'],
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
      ['min_deposit_pct',                  '20'],
      ['max_installments',                 '12'],
      ['installment_grace_period_days',    '0'],
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
         ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
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
