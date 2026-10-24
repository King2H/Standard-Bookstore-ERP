/**
 * Demo data, on request only (owner decision 1a, 2026-10-24): eight books
 * with their authors, categories, publishers and tags, two suppliers and
 * three customers, so the system can be tried without typing a catalog.
 * `npm run db:demo` loads it into an empty shop, as the database owner; a
 * fresh install has none of it.
 *
 * The customers start with no store credit and no points (3a): any balance
 * comes from a sale or a return, with its history. Stock starts at 0; it
 * arrives by stock-in or a purchase order, at its cost.
 */
import type pg from 'pg';
import { DEFAULT_TENANT_ID } from './seed.js';

const BOOKS: Array<{
  isbn: string; title: string; author: string; genre: string; publisher: string; format: string;
  price: string; tradeValue: string; categories: string[]; tags: string[];
}> = [
  { isbn: '9780451524935', title: 'Nineteen Eighty-Four', author: 'George Orwell', genre: 'Fiction', publisher: 'Secker & Warburg', format: 'Paperback', price: '12.99', tradeValue: '4.00', categories: ['Fiction', 'Classic', 'Dystopian'], tags: ['totalitarianism', 'surveillance'] },
  { isbn: '9780439708180', title: "Harry Potter and the Sorcerer's Stone", author: 'J.K. Rowling', genre: 'Fantasy', publisher: 'Scholastic', format: 'Hardcover', price: '19.99', tradeValue: '6.00', categories: ['Fantasy', 'Fiction'], tags: ['magic', 'coming-of-age'] },
  { isbn: '9780441013593', title: 'Dune', author: 'Frank Herbert', genre: 'Science Fiction', publisher: 'Chilton Books', format: 'Paperback', price: '14.99', tradeValue: '5.00', categories: ['Science Fiction', 'Classic'], tags: ['space-opera', 'politics'] },
  { isbn: '9780061743528', title: 'To Kill a Mockingbird', author: 'Harper Lee', genre: 'Fiction', publisher: 'J. B. Lippincott', format: 'Paperback', price: '11.99', tradeValue: '3.50', categories: ['Fiction', 'Classic', 'Literary Fiction'], tags: ['race', 'justice'] },
  { isbn: '9780743273565', title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', genre: 'Fiction', publisher: "Charles Scribner's", format: 'Paperback', price: '10.99', tradeValue: '3.00', categories: ['Fiction', 'Classic', 'Literary Fiction'], tags: ['jazz-age', 'american-dream'] },
  { isbn: '9780618640157', title: 'The Lord of the Rings', author: 'J.R.R. Tolkien', genre: 'Fantasy', publisher: 'Allen & Unwin', format: 'Hardcover', price: '29.99', tradeValue: '9.00', categories: ['Fantasy', 'Classic'], tags: ['epic', 'mythology'] },
  { isbn: '9780060883287', title: 'One Hundred Years of Solitude', author: 'Gabriel García Márquez', genre: 'Fiction', publisher: 'Harper & Row', format: 'Paperback', price: '13.99', tradeValue: '4.50', categories: ['Fiction', 'Magical Realism', 'Literary Fiction'], tags: ['family', 'solitude'] },
  { isbn: '9780060850524', title: 'Brave New World', author: 'Aldous Huxley', genre: 'Science Fiction', publisher: 'Chatto & Windus', format: 'Paperback', price: '11.99', tradeValue: '3.50', categories: ['Science Fiction', 'Classic', 'Dystopian'], tags: ['society', 'technology'] },
];

const SUPPLIERS = [
  { name: 'Book Distributors Inc', contact: { phone: '555-1000', email: 'orders@bookdist.com' }, leadTimeDays: 5, publisher: null },
  { name: 'Oxford University Press Direct', contact: { phone: '555-2000', email: 'supply@oup.com' }, leadTimeDays: 14, publisher: 'Oxford University Press' },
];

const CUSTOMERS = ['Alice Johnson', 'Bob Smith', 'Carol White'];

export interface DemoDataLoaded {
  books: number;
  suppliers: number;
  customers: number;
}

/**
 * Loads the demo data into a shop that has no books, customers or suppliers,
 * in one transaction, audited. `client` is the database owner's connection.
 *
 * `missingOnly` adds only the demo rows the shop lacks, to any shop: the test
 * database keeps its data between runs, and its untouched demo rows were
 * removed by migration 1700000078.
 */
export async function loadDemoData(
  client: pg.ClientBase,
  tenantId = DEFAULT_TENANT_ID,
  { missingOnly = false }: { missingOnly?: boolean } = {},
): Promise<DemoDataLoaded> {
  const id = async (text: string, values: unknown[]) => (await client.query(text, values)).rows[0].id as number;
  await client.query('BEGIN');
  try {
    // Every row below belongs to the tenant (#13).
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(tenantId)]);
    const { rows: [used] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM books WHERE tenant_id = $1)
           OR EXISTS (SELECT 1 FROM customers WHERE tenant_id = $1)
           OR EXISTS (SELECT 1 FROM suppliers WHERE tenant_id = $1) AS used`,
      [tenantId],
    );
    if (used.used && !missingOnly) throw new Error('The shop already has books, customers or suppliers: demo data is for an empty shop');
    const loaded: DemoDataLoaded = { books: 0, suppliers: 0, customers: 0 };

    const named = async (table: 'authors' | 'categories', name: string) => {
      await client.query(`INSERT INTO ${table} (name, normalized_name) VALUES ($1, lower($1)) ON CONFLICT DO NOTHING`, [name]);
      return id(`SELECT id FROM ${table} WHERE tenant_id = $1 AND normalized_name = lower($2)`, [tenantId, name]);
    };
    const publisher = async (name: string) => {
      await client.query(`INSERT INTO publishers (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
      return id(`SELECT id FROM publishers WHERE tenant_id = $1 AND lower(btrim(name)) = lower($2)`, [tenantId, name]);
    };

    const reorderPoint = (await client.query(
      `SELECT COALESCE((SELECT (value #>> '{}')::int FROM system_config WHERE tenant_id = $1 AND key = 'reorder_point_default'), 5) AS n`,
      [tenantId],
    )).rows[0].n as number;
    for (const b of BOOKS) {
      const { rows: [book] } = await client.query(
        `INSERT INTO books (isbn, title, genre, publisher, publisher_id, language, format, default_price, trade_value)
         VALUES ($1, $2, $3, $4, $5, 'English', $6, $7, $8) ON CONFLICT (tenant_id, isbn) DO NOTHING RETURNING id`,
        [b.isbn, b.title, b.genre, b.publisher, await publisher(b.publisher), b.format, b.price, b.tradeValue],
      );
      if (!book) continue;
      const bookId = book.id as number;
      loaded.books += 1;
      await client.query(`INSERT INTO book_authors (book_id, author_id, sort_order) VALUES ($1, $2, 0)`, [bookId, await named('authors', b.author)]);
      for (const category of b.categories) {
        await client.query(`INSERT INTO book_categories (book_id, category_id) VALUES ($1, $2)`, [bookId, await named('categories', category)]);
      }
      for (const tag of b.tags) await client.query(`INSERT INTO book_tags (book_id, tag) VALUES ($1, $2)`, [bookId, tag]);
      await client.query(
        `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
         SELECT $1, l.id, 0, $3, 0 FROM locations l WHERE l.tenant_id = $2`,
        [bookId, tenantId, reorderPoint],
      );
    }

    for (const s of SUPPLIERS) {
      const added = await client.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type, publisher_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, name) DO NOTHING`,
        [s.name, JSON.stringify(s.contact), s.leadTimeDays, s.publisher ? 'publisher' : 'external', s.publisher ? await publisher(s.publisher) : null],
      );
      loaded.suppliers += added.rowCount ?? 0;
    }

    // Registered at the first branch; codes from the shop's running series, as Customers gives them (#68).
    for (const fullName of CUSTOMERS) {
      const exists = await client.query(`SELECT 1 FROM customers WHERE tenant_id = $1 AND full_name = $2`, [tenantId, fullName]);
      if (exists.rowCount) continue;
      loaded.customers += 1;
      const { rows: [counter] } = await client.query(
        `INSERT INTO document_counters (series, period, last_value) VALUES ('CUS', '', 1)
         ON CONFLICT (tenant_id, series, period) DO UPDATE SET last_value = document_counters.last_value + 1
         RETURNING last_value`,
      );
      const customerId = await id(
        `INSERT INTO customers (branch_id, customer_code, full_name)
         VALUES ((SELECT id FROM branches WHERE tenant_id = $1 ORDER BY id LIMIT 1), $2, $3) RETURNING id`,
        [tenantId, `CUS-${String(counter.last_value).padStart(4, '0')}`, fullName],
      );
      await client.query(`INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points) VALUES ($1, 0, 0)`, [customerId]);
      await client.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 0)`, [customerId]);
    }

    if (loaded.books + loaded.suppliers + loaded.customers === 0) {
      await client.query('COMMIT');
      return loaded;
    }
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
       VALUES (NULL, 'system', 'CREATE', 'demo_data', 'demo', $1)`,
      [JSON.stringify({ ...loaded, reason: 'Demo data loaded on request (npm run db:demo)' })],
    );
    await client.query('COMMIT');
    return loaded;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
