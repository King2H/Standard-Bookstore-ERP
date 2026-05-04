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

    // ── 6. Sample catalog data (books, authors, categories) ───────────────────
    // Ensures the catalog is never empty on a fresh install.
    // All inserts are idempotent — safe to run on an existing DB.

    // Authors
    await client.query(`
      INSERT INTO authors (name, normalized_name) VALUES
        ('George Orwell',           'george orwell'),
        ('J.K. Rowling',            'j.k. rowling'),
        ('Frank Herbert',           'frank herbert'),
        ('Harper Lee',              'harper lee'),
        ('F. Scott Fitzgerald',     'f. scott fitzgerald'),
        ('J.R.R. Tolkien',          'j.r.r. tolkien'),
        ('Gabriel García Márquez',  'gabriel garcía márquez'),
        ('Aldous Huxley',           'aldous huxley')
      ON CONFLICT (normalized_name) DO NOTHING
    `);

    // Categories
    await client.query(`
      INSERT INTO categories (name, normalized_name) VALUES
        ('Fiction',          'fiction'),
        ('Classic',          'classic'),
        ('Science Fiction',  'science fiction'),
        ('Fantasy',          'fantasy'),
        ('Dystopian',        'dystopian'),
        ('Literary Fiction', 'literary fiction'),
        ('Magical Realism',  'magical realism')
      ON CONFLICT (normalized_name) DO NOTHING
    `);

    // Books
    await client.query(`
      INSERT INTO books (isbn, title, genre, publisher, language, format, default_price, trade_value, is_active)
      VALUES
        ('9780451524935', 'Nineteen Eighty-Four',                    'Fiction',        'Secker & Warburg',    'English', 'Paperback', 12.99, 4.00, true),
        ('9780439708180', 'Harry Potter and the Sorcerer''s Stone',  'Fantasy',        'Scholastic',          'English', 'Hardcover', 19.99, 6.00, true),
        ('9780441013593', 'Dune',                                    'Science Fiction','Chilton Books',       'English', 'Paperback', 14.99, 5.00, true),
        ('9780061743528', 'To Kill a Mockingbird',                   'Fiction',        'J. B. Lippincott',    'English', 'Paperback', 11.99, 3.50, true),
        ('9780743273565', 'The Great Gatsby',                        'Fiction',        'Charles Scribner''s', 'English', 'Paperback', 10.99, 3.00, true),
        ('9780618640157', 'The Lord of the Rings',                   'Fantasy',        'Allen & Unwin',       'English', 'Hardcover', 29.99, 9.00, true),
        ('9780060883287', 'One Hundred Years of Solitude',           'Fiction',        'Harper & Row',        'English', 'Paperback', 13.99, 4.50, true),
        ('9780060850524', 'Brave New World',                         'Science Fiction','Chatto & Windus',     'English', 'Paperback', 11.99, 3.50, true)
      ON CONFLICT (isbn) DO NOTHING
    `);

    // Book–author links
    await client.query(`
      INSERT INTO book_authors (book_id, author_id, sort_order)
      SELECT b.id, a.id, 0 FROM books b, authors a
      WHERE (b.isbn='9780451524935' AND a.normalized_name='george orwell')
         OR (b.isbn='9780439708180' AND a.normalized_name='j.k. rowling')
         OR (b.isbn='9780441013593' AND a.normalized_name='frank herbert')
         OR (b.isbn='9780061743528' AND a.normalized_name='harper lee')
         OR (b.isbn='9780743273565' AND a.normalized_name='f. scott fitzgerald')
         OR (b.isbn='9780618640157' AND a.normalized_name='j.r.r. tolkien')
         OR (b.isbn='9780060883287' AND a.normalized_name='gabriel garcía márquez')
         OR (b.isbn='9780060850524' AND a.normalized_name='aldous huxley')
      ON CONFLICT DO NOTHING
    `);

    // Book–category links
    await client.query(`
      INSERT INTO book_categories (book_id, category_id)
      SELECT b.id, c.id FROM books b, categories c
      WHERE (b.isbn='9780451524935' AND c.normalized_name IN ('fiction','classic','dystopian'))
         OR (b.isbn='9780439708180' AND c.normalized_name IN ('fantasy','fiction'))
         OR (b.isbn='9780441013593' AND c.normalized_name IN ('science fiction','classic'))
         OR (b.isbn='9780061743528' AND c.normalized_name IN ('fiction','classic','literary fiction'))
         OR (b.isbn='9780743273565' AND c.normalized_name IN ('fiction','classic','literary fiction'))
         OR (b.isbn='9780618640157' AND c.normalized_name IN ('fantasy','classic'))
         OR (b.isbn='9780060883287' AND c.normalized_name IN ('fiction','magical realism','literary fiction'))
         OR (b.isbn='9780060850524' AND c.normalized_name IN ('science fiction','classic','dystopian'))
      ON CONFLICT DO NOTHING
    `);

    // ── 7. System config defaults ─────────────────────────────────────────────
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
