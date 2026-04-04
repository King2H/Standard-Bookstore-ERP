/**
 * Restores seed data wiped by tests. Otherwise, complete messup.
 * Run: node scripts/reseed.mjs -- for reference
 */
import pg from 'pg';
import bcrypt from 'bcrypt';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function reseed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Restore Main Branch ──────────────────────────────────────────────
    await client.query(`
      INSERT INTO branches (id, name, address, contact_info, operating_hours, is_active)
      VALUES (1, 'Main Branch', '1 Bookstore Avenue, City',
        '{"phone":"555-0100","email":"main@bookstore.com"}',
        '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00","sat":"10:00-16:00","sun":"closed"}',
        true)
      ON CONFLICT (id) DO UPDATE SET is_active = true, name = 'Main Branch'
    `);

    // ── Restore superadmin ───────────────────────────────────────────────
    const superHash = await bcrypt.hash('password', 12);
    await client.query(`
      INSERT INTO staff (id, username, password_hash, full_name, is_active)
      VALUES (1, 'superadmin', $1, 'Super Admin', true)
      ON CONFLICT (id) DO UPDATE SET password_hash = $1, is_active = true, username = 'superadmin'
    `, [superHash]);

    // ── Restore admin ────────────────────────────────────────────────────
    const adminHash = await bcrypt.hash('password', 12);
    await client.query(`
      INSERT INTO staff (id, username, password_hash, full_name, is_active)
      VALUES (2, 'admin', $1, 'Admin User', true)
      ON CONFLICT (id) DO UPDATE SET password_hash = $1, is_active = true, username = 'admin'
    `, [adminHash]);

    // ── Restore role assignments ─────────────────────────────────────────
    await client.query(`
      INSERT INTO staff_branch_roles (staff_id, branch_id, role)
      VALUES (1, 1, 'Super_Admin'), (2, 1, 'Admin')
      ON CONFLICT DO NOTHING
    `);

    // ── Restore system_config defaults ───────────────────────────────────
    const defaults = [
      ['base_currency',                    '"USD"'],
      ['tax_rate',                         '0.10'],
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

    for (const [key, value] of defaults) {
      await client.query(`
        INSERT INTO system_config (key, value, updated_by)
        VALUES ($1, $2::jsonb, 1)
        ON CONFLICT (key) DO NOTHING
      `, [key, value]);
    }

    // Reset sequences to avoid ID conflicts with future inserts
    await client.query(`SELECT setval('branches_id_seq', (SELECT MAX(id) FROM branches))`);
    await client.query(`SELECT setval('staff_id_seq', (SELECT MAX(id) FROM staff))`);

    // ── Restore default locations for each branch ────────────────────────
    // The migration seeds this on first run; reseed must be idempotent.
    await client.query(`
      INSERT INTO locations (branch_id, name, is_default_fulfillment)
      SELECT id, 'Main Floor', true
      FROM branches
      ON CONFLICT DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✓ Seed data restored successfully');
    console.log('  - Main Branch (id=1) active');
    console.log('  - superadmin / password (Super_Admin @ Main Branch)');
    console.log('  - admin / password (Admin @ Main Branch)');
    console.log('  - 21 system_config defaults present');
    console.log('  - Default "Main Floor" location per branch');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Reseed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

reseed();
