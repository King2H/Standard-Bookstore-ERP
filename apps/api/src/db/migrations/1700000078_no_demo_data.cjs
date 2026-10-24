'use strict';

// A fresh install has no demo data (owner decisions 1a, 2a, 3a, 4a,
// 2026-10-24); `npm run db:demo` loads it on request.
//
// The early migrations seeded eight books (with their authors, categories,
// publishers and tags), two suppliers and three customers holding store
// credit and points that no sale or return explains. Where a demo row was
// never used, it is removed, each removal audited (2a): a book with no stock
// movement, sale, order, purchase order, return, exchange, branch price,
// supplier link or edit; a customer with no sale, order, return, exchange,
// receivable, credit or points history, group or edit; a supplier with no
// purchase order, payment, credit note, book link or edit; an author,
// category or publisher no longer used by a book or supplier and never
// edited. A demo row that was used stays. New installs lose them the same way.
//
// Main Branch was given a made-up address and phone ("1 Bookstore Avenue,
// City", 555-0100). Where they are still those, they are cleared, audited
// (4a); the shop enters its own.
//
// Running it again changes nothing. The down migration restores nothing.

exports.shorthands = undefined;

const BOOKS = `('9780451524935', 'Nineteen Eighty-Four'), ('9780439708180', 'Harry Potter and the Sorcerer''s Stone'),
  ('9780441013593', 'Dune'), ('9780061743528', 'To Kill a Mockingbird'), ('9780743273565', 'The Great Gatsby'),
  ('9780618640157', 'The Lord of the Rings'), ('9780060883287', 'One Hundred Years of Solitude'), ('9780060850524', 'Brave New World')`;
const AUTHORS = `'george orwell', 'j.k. rowling', 'frank herbert', 'harper lee', 'f. scott fitzgerald', 'j.r.r. tolkien',
  'gabriel garcía márquez', 'aldous huxley'`;
const CATEGORIES = `'fiction', 'classic', 'science fiction', 'fantasy', 'dystopian', 'literary fiction', 'magical realism'`;
const PUBLISHERS = `'secker & warburg', 'scholastic', 'chilton books', 'j. b. lippincott', 'charles scribner''s', 'allen & unwin',
  'harper & row', 'chatto & windus'`;
const SUPPLIERS = `'Book Distributors Inc', 'Oxford University Press Direct'`;
const CUSTOMERS = `('CUS-0001', 'Alice Johnson'), ('CUS-0002', 'Bob Smith'), ('CUS-0003', 'Carol White')`;

const REASON = 'Demo data of a fresh install, never used';
const notEdited = (type, alias) =>
  `NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.tenant_id = ${alias}.tenant_id AND a.entity_type = '${type}' AND a.entity_id = ${alias}.id::text)`;

/** Removes the rows `candidates` selects (id, tenant_id, meta) from `table`, one audit entry each. */
const removeAudited = (table, type, candidates) => `
  WITH candidates AS (${candidates}),
  removed AS (DELETE FROM ${table} WHERE id IN (SELECT id FROM candidates) RETURNING id)
  INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
  SELECT c.tenant_id, NULL, 'system', 'DELETE', '${type}', c.id::text, NULL, c.meta || jsonb_build_object('reason', '${REASON}')
  FROM candidates c JOIN removed r ON r.id = c.id
  ORDER BY c.id;
`;

exports.up = function (pgm) {
  // Books first; their authors, categories, tags and empty stock rows go with them (ON DELETE CASCADE).
  pgm.sql(removeAudited('books', 'book', `
    SELECT b.id, b.tenant_id, jsonb_build_object('isbn', b.isbn, 'title', b.title) AS meta
    FROM books b JOIN (VALUES ${BOOKS}) AS d (isbn, title) ON d.isbn = b.isbn AND d.title = b.title
    WHERE ${notEdited('book', 'b')}
      AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.book_id = b.id AND (i.quantity <> 0 OR i.damaged_quantity <> 0))
      AND NOT EXISTS (SELECT 1 FROM inventory_history x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM inventory_reservations x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM transaction_line_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM order_line_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM po_line_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM return_line_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM exchange_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM exchange_incoming_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM exchange_outgoing_items x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM book_branch_prices x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM book_suppliers x WHERE x.book_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM book_edit_history x WHERE x.book_id = b.id)
  `));

  pgm.sql(removeAudited('suppliers', 'supplier', `
    SELECT s.id, s.tenant_id, jsonb_build_object('name', s.name) AS meta
    FROM suppliers s
    WHERE s.name IN (${SUPPLIERS}) AND ${notEdited('supplier', 's')}
      AND NOT EXISTS (SELECT 1 FROM purchase_orders x WHERE x.supplier_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM supplier_payments x WHERE x.supplier_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes x WHERE x.supplier_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM book_suppliers x WHERE x.supplier_id = s.id)
  `));

  // Their store credit and points accounts go with them; the balances are named in the audit entry.
  pgm.sql(removeAudited('customers', 'customer', `
    SELECT c.id, c.tenant_id,
           jsonb_build_object(
             'customerCode', c.customer_code, 'fullName', c.full_name,
             'storeCredit', (SELECT balance::text FROM store_credit_accounts a WHERE a.customer_id = c.id),
             'loyaltyPoints', (SELECT points_balance::text FROM loyalty_accounts a WHERE a.customer_id = c.id)
           ) AS meta
    FROM customers c JOIN (VALUES ${CUSTOMERS}) AS d (code, name) ON d.code = c.customer_code AND d.name = c.full_name
    WHERE ${notEdited('customer', 'c')}
      AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM returns x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM exchanges x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM receivables x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM store_credit_history x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM loyalty_history x WHERE x.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM customer_group_membership x WHERE x.customer_id = c.id)
  `));

  pgm.sql(removeAudited('authors', 'author', `
    SELECT a.id, a.tenant_id, jsonb_build_object('name', a.name) AS meta
    FROM authors a
    WHERE a.normalized_name IN (${AUTHORS}) AND ${notEdited('author', 'a')}
      AND NOT EXISTS (SELECT 1 FROM book_authors x WHERE x.author_id = a.id)
  `));

  pgm.sql(removeAudited('categories', 'category', `
    SELECT c.id, c.tenant_id, jsonb_build_object('name', c.name) AS meta
    FROM categories c
    WHERE c.normalized_name IN (${CATEGORIES}) AND ${notEdited('category', 'c')}
      AND NOT EXISTS (SELECT 1 FROM book_categories x WHERE x.category_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM categories x WHERE x.parent_id = c.id)
  `));

  pgm.sql(removeAudited('publishers', 'publisher', `
    SELECT p.id, p.tenant_id, jsonb_build_object('name', p.name) AS meta
    FROM publishers p
    WHERE lower(btrim(p.name)) IN (${PUBLISHERS}) AND ${notEdited('publisher', 'p')}
      AND NOT EXISTS (SELECT 1 FROM books x WHERE x.publisher_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM suppliers x WHERE x.publisher_id = p.id)
  `));

  pgm.sql(`
    WITH placeholder AS (
      SELECT b.id, b.tenant_id, b.address, b.contact_info
      FROM branches b
      WHERE b.address = '1 Bookstore Avenue, City'
        AND b.contact_info = '{"phone":"555-0100","email":"main@bookstore.com"}'::jsonb
    ),
    cleared AS (
      UPDATE branches b SET address = '', contact_info = '{}'::jsonb
      FROM placeholder p WHERE b.id = p.id
      RETURNING b.id
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
    SELECT p.tenant_id, NULL, 'system', 'UPDATE', 'branch', p.id::text, p.id,
           jsonb_build_object(
             'previousAddress', p.address,
             'previousContactInfo', p.contact_info,
             'reason', 'Made-up address and phone of a fresh install; the shop enters its own'
           )
    FROM placeholder p JOIN cleared c ON c.id = p.id;
  `);
};

exports.down = function () {};
