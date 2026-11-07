// What the import from a v1 shop (#246 part 5) reads from a copy of a v1
// database (release/1.x, last migration 50). The copy is not a v2 database,
// so these queries use a plain connection to it, not Kysely and its types.
// Amounts are summed and rounded by PostgreSQL (numeric), and read as text.

/** A connection to the v1 copy (a pg Client or Pool). */
export interface V1Db {
  query<R extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** Whether the copy has a table: asked of the table itself (42P01: there is none). */
async function hasTable(db: V1Db, table: 'pgmigrations' | 'tenants'): Promise<boolean> {
  try {
    await db.query(`SELECT 1 FROM ${table} LIMIT 0`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return false;
    throw err;
  }
}

/** What tells v1 from v2: the migrations table, its last migration, and the tenants table (v2 only). */
export async function describeDatabase(db: V1Db): Promise<{ tables: string[]; lastMigration: string | null }> {
  const tables = [];
  for (const table of ['pgmigrations', 'tenants'] as const) if (await hasTable(db, table)) tables.push(table);
  const lastMigration = tables.includes('pgmigrations')
    ? (await db.query<{ name: string | null }>(`SELECT max(name) AS name FROM pgmigrations`)).rows[0].name
    : null;
  return { tables, lastMigration };
}

export interface V1Book {
  isbn: string;
  sku: string | null;
  title: string;
  authors: string | null;
  publisher: string | null;
  categories: string | null;
  genre: string | null;
  formatLabel: string | null;
  formatText: string | null;
  language: string | null;
  price: string | null;
  status: string;
  inStock: boolean;
}

export async function books(db: V1Db): Promise<V1Book[]> {
  return (await db.query<V1Book>(`
    SELECT b.isbn, b.sku, b.title, b.genre, b.language, b.status,
           COALESCE(p.name, b.publisher) AS publisher, f.label AS "formatLabel", b.format AS "formatText",
           ROUND(b.default_price, 2)::text AS price,
           (SELECT string_agg(a.name, '; ' ORDER BY ba.sort_order, a.id) FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id) AS authors,
           (SELECT string_agg(c.name, '; ' ORDER BY c.id) FROM book_categories bc JOIN categories c ON c.id = bc.category_id WHERE bc.book_id = b.id) AS categories,
           EXISTS (SELECT 1 FROM inventory i WHERE i.book_id = b.id AND i.quantity > 0) AS "inStock"
      FROM books b
      LEFT JOIN publishers p ON p.id = b.publisher_id
      LEFT JOIN book_formats f ON f.id = b.format_id
     ORDER BY b.id`)).rows;
}

export async function formats(db: V1Db): Promise<Array<{ code: string; label: string }>> {
  return (await db.query<{ code: string; label: string }>(`SELECT code, label FROM book_formats ORDER BY sort_order, id`)).rows;
}

export interface V1Stock {
  branch: string;
  isbn: string;
  title: string;
  location: string;
  quantity: number;
  damaged: number;
  unitCost: string;
  reorderPoint: number;
}

/** Each book at each location with copies (good or damaged), by branch. */
export async function stock(db: V1Db): Promise<V1Stock[]> {
  return (await db.query<V1Stock>(`
    SELECT br.name AS branch, b.isbn, b.title, l.name AS location, i.quantity, i.damaged_quantity AS damaged,
           ROUND(i.average_cost, 2)::text AS "unitCost", i.reorder_point AS "reorderPoint"
      FROM inventory i
      JOIN books b ON b.id = i.book_id
      JOIN locations l ON l.id = i.location_id
      JOIN branches br ON br.id = l.branch_id
     WHERE i.quantity <> 0 OR i.damaged_quantity > 0
     ORDER BY br.id, b.id, l.id`)).rows;
}

export interface V1Customer {
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  phoneEncrypted: string | null;
  emailEncrypted: string | null;
  address: string | null;
  city: string | null;
  status: string;
  /** What is still owed on unsettled receivables. */
  owed: string;
  /** The earliest due date among them, YYYY-MM-DD. */
  due: string | null;
  credit: string;
  points: string;
}

export async function customers(db: V1Db): Promise<V1Customer[]> {
  return (await db.query<V1Customer>(`
    WITH open AS (
      SELECT customer_id, SUM(outstanding_amount) AS owed, MIN(due_date) AS due
        FROM receivables WHERE status <> 'Settled' AND outstanding_amount > 0 GROUP BY customer_id
    )
    SELECT c.customer_code AS code, c.full_name AS name, c.phone, c.email, c.phone_encrypted AS "phoneEncrypted",
           c.email_encrypted AS "emailEncrypted", c.address, c.city, c.status,
           ROUND(COALESCE(o.owed, 0), 2)::text AS owed, TO_CHAR(o.due, 'YYYY-MM-DD') AS due,
           ROUND(COALESCE(s.balance, 0), 2)::text AS credit, COALESCE(la.points_balance, 0)::text AS points
      FROM customers c
      LEFT JOIN open o ON o.customer_id = c.id
      LEFT JOIN store_credit_accounts s ON s.customer_id = c.id
      LEFT JOIN loyalty_accounts la ON la.customer_id = c.id
     ORDER BY c.customer_code`)).rows;
}

export interface V1Supplier {
  name: string;
  phone: string | null;
  email: string | null;
  /** Received, less paid, less credit notes, over its orders, as v1 shows each order's outstanding amount. */
  owed: string;
}

export async function suppliers(db: V1Db): Promise<V1Supplier[]> {
  return (await db.query<V1Supplier>(`
    SELECT s.name, s.contact_info->>'phone' AS phone, s.contact_info->>'email' AS email,
           ROUND(COALESCE((
             SELECT SUM(
                      COALESCE((SELECT SUM(li.received_quantity * li.unit_cost) FROM po_line_items li WHERE li.po_id = po.id), 0)
                    - COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.po_id = po.id), 0)
                    - COALESCE((SELECT SUM(cn.amount) FROM supplier_credit_notes cn WHERE cn.po_id = po.id), 0))
               FROM purchase_orders po WHERE po.supplier_id = s.id), 0), 2)::text AS owed
      FROM suppliers s
     ORDER BY s.name`)).rows;
}

/** Branch names, for the summary. */
export async function branchNames(db: V1Db): Promise<string[]> {
  return (await db.query<{ name: string }>(`SELECT name FROM branches ORDER BY id`)).rows.map((r) => r.name);
}
