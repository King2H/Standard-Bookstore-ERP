import pg from 'pg';
import { db } from '../../db/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';

type PoolClient = pg.PoolClient;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StaffCtx {
  staffId: number;
  role: string;
  branchId: number;
}

export interface BookInput {
  isbn: string;
  sku?: string;
  title: string;
  authors: string[];
  authorIds?: number[];
  genre?: string;
  publisher?: string;
  publisherId?: number | null;
  formatId?: number | null;   // FK to book_formats
  editionId?: number | null;  // FK to book_editions
  edition?: string;           // legacy free-text (kept for backward compat)
  language?: string;
  format?: string;            // legacy free-text (kept for backward compat)
  description?: string;
  coverImageUrl?: string;
  defaultPrice?: number;
  tradeValue?: number;
  categories?: string[];
  categoryIds?: number[];
  tags?: string[];
}

export interface BookRecord {
  id: number;
  isbn: string;
  sku: string | null;
  title: string;
  authors: string[];
  authorIds: number[];
  genre: string | null;
  publisher: string | null;
  publisherId: number | null;
  formatId: number | null;
  formatCode: string | null;
  formatLabel: string | null;
  editionId: number | null;
  editionCode: string | null;
  editionLabel: string | null;
  edition: string | null;   // legacy free-text
  language: string | null;
  format: string | null;    // legacy free-text
  description: string | null;
  coverImageUrl: string | null;
  defaultPrice: number | null;
  tradeValue: number | null;
  isActive: boolean;
  createdAt: string;
  categories: string[];
  categoryIds: number[];
  tags: string[];
  branchPrice?: number | null;
  stockQuantity?: number | null;
}

export interface SearchFilters {
  q?: string;
  isbn?: string;
  sku?: string;
  author?: string;
  genre?: string;
  category?: string;
  tag?: string;
  isActive?: boolean;
  branchId?: number;
  locationId?: number;
  sortBy?: 'title' | 'isbn' | 'created_at' | 'default_price';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

// ── ISBN-13 check digit validation ────────────────────────────────────────────

export function validateIsbn13(isbn: string): boolean {
  const digits = isbn.replace(/[-\s]/g, '');
  if (!/^\d{13}$/.test(digits)) return false;
  const sum = digits.split('').reduce((acc, d, i) => {
    return acc + parseInt(d, 10) * (i % 2 === 0 ? 1 : 3);
  }, 0);
  return sum % 10 === 0;
}

// ── Author helpers ────────────────────────────────────────────────────────────
// Upsert by normalized_name (case-insensitive dedup). Returns author IDs.

async function upsertAuthors(
  client: PoolClient,
  names: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) continue;
    const result = await client.query(
      `INSERT INTO authors (name, normalized_name)
       VALUES ($1, $2)
       ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name.trim(), normalized],
    );
    ids.push(result.rows[0].id as number);
  }
  return ids;
}

// ── Category helpers ──────────────────────────────────────────────────────────

async function upsertCategories(
  client: PoolClient,
  names: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) continue;
    const result = await client.query(
      `INSERT INTO categories (name, normalized_name)
       VALUES ($1, $2)
       ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name.trim(), normalized],
    );
    ids.push(result.rows[0].id as number);
  }
  return ids;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapBook(row: Record<string, unknown>): BookRecord {
  return {
    id: row.id as number,
    isbn: row.isbn as string,
    sku: (row.sku as string | null) ?? null,
    title: row.title as string,
    authors: (row.authors as string[] | null) ?? [],
    authorIds: (row.author_ids as number[] | null) ?? [],
    genre: (row.genre as string | null) ?? null,
    publisher: (row.publisher as string | null) ?? null,
    publisherId: (row.publisher_id as number | null) ?? null,
    formatId: (row.format_id as number | null) ?? null,
    formatCode: (row.format_code as string | null) ?? null,
    formatLabel: (row.format_label as string | null) ?? null,
    editionId: (row.edition_id as number | null) ?? null,
    editionCode: (row.edition_code as string | null) ?? null,
    editionLabel: (row.edition_label as string | null) ?? null,
    edition: (row.edition as string | null) ?? null,
    language: (row.language as string | null) ?? null,
    format: (row.format as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    coverImageUrl: (row.cover_image_url as string | null) ?? null,
    defaultPrice: row.default_price != null ? parseFloat(row.default_price as string) : null,
    tradeValue: row.trade_value != null ? parseFloat(row.trade_value as string) : null,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    categories: (row.categories as string[] | null) ?? [],
    categoryIds: (row.category_ids as number[] | null) ?? [],
    tags: (row.tags as string[] | null) ?? [],
    branchPrice: row.branch_price != null ? parseFloat(row.branch_price as string) : null,
    stockQuantity: row.stock_quantity != null ? parseInt(row.stock_quantity as string, 10) : null,
  };
}

// ── Fetch full book with authors, categories, tags ────────────────────────────

async function fetchBookById(
  bookId: number,
  branchId?: number,
): Promise<BookRecord | null> {
  const result = await db.query(
    `SELECT
       b.id, b.isbn, b.sku, b.title, b.genre, b.publisher, b.publisher_id,
       b.edition, b.language, b.format, b.description, b.cover_image_url,
       b.default_price, b.trade_value, b.is_active, b.created_at,
       b.format_id, bf.code AS format_code, bf.label AS format_label,
       b.edition_id, be.code AS edition_code, be.label AS edition_label,
       COALESCE(
         ARRAY_AGG(DISTINCT a.name ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL),
         '{}'
       ) AS authors,
       COALESCE(
         ARRAY_AGG(a.id ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL),
         '{}'
       ) AS author_ids,
       COALESCE(
         ARRAY_AGG(DISTINCT c.name ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
         '{}'
       ) AS categories,
       COALESCE(
         ARRAY_AGG(c.id ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
         '{}'
       ) AS category_ids,
       COALESCE(
         ARRAY_AGG(DISTINCT bt.tag ORDER BY bt.tag) FILTER (WHERE bt.tag IS NOT NULL),
         '{}'
       ) AS tags,
       bbp.price AS branch_price

     FROM books b
     LEFT JOIN book_formats bf ON bf.id = b.format_id
     LEFT JOIN book_editions be ON be.id = b.edition_id
     LEFT JOIN book_authors ba ON ba.book_id = b.id
     LEFT JOIN authors a ON a.id = ba.author_id
     LEFT JOIN book_categories bc ON bc.book_id = b.id
     LEFT JOIN categories c ON c.id = bc.category_id
     LEFT JOIN book_tags bt ON bt.book_id = b.id
     LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = $2
       AND bbp.format_id = 0 AND bbp.edition_id = 0
     WHERE b.id = $1
     GROUP BY b.id, bf.code, bf.label, be.code, be.label, bbp.price`,
    [bookId, branchId ?? null],
  );
  if (result.rows.length === 0) return null;
  return mapBook(result.rows[0]);
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createBook(data: BookInput, staffCtx: StaffCtx): Promise<BookRecord> {
  // ISBN is optional in the UI — if blank, auto-generate a placeholder
  const rawIsbn = data.isbn ? data.isbn.replace(/[-\s]/g, '') : '';
  if (rawIsbn && !validateIsbn13(rawIsbn)) {
    throw new ValidationError('Invalid ISBN-13 check digit');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Insert book — use placeholder ISBN if none provided (will be replaced by trigger-generated value)
    let bookResult;
    try {
      // If no ISBN provided, generate a unique placeholder from SKU or timestamp
      const isbnToInsert = rawIsbn || `SKU-${(data.sku ?? '').replace(/\s/g, '-') || Date.now()}`;
      bookResult = await client.query(
        `INSERT INTO books (isbn, sku, title, genre, publisher, publisher_id, format_id, edition_id,
                            edition, language, format, description, cover_image_url,
                            default_price, trade_value, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true)
         RETURNING id`,
        [
          isbnToInsert,
          data.sku?.trim() || null,
          data.title,
          data.genre ?? null,
          data.publisher ?? null,
          data.publisherId ?? null,
          data.formatId ?? null,
          data.editionId ?? null,
          data.edition ?? null,
          data.language ?? null,
          data.format ?? null,
          data.description ?? null,
          data.coverImageUrl ?? null,
          data.defaultPrice ?? null,
          data.tradeValue ?? null,
        ],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('DUPLICATE_ISBN', `ISBN '${data.isbn}' already exists in the catalog`);
      }
      throw err;
    }

    const bookId: number = bookResult.rows[0].id;

    // Link authors — prefer authorIds (master data), fall back to name-based upsert
    const resolvedAuthorIds: number[] = data.authorIds && data.authorIds.length > 0
      ? data.authorIds
      : (data.authors.length > 0 ? await upsertAuthors(client, data.authors) : []);
    for (let i = 0; i < resolvedAuthorIds.length; i++) {
      await client.query(
        `INSERT INTO book_authors (book_id, author_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [bookId, resolvedAuthorIds[i], i],
      );
    }

    // Link categories — prefer categoryIds, fall back to name-based upsert
    const resolvedCatIds: number[] = data.categoryIds && data.categoryIds.length > 0
      ? data.categoryIds
      : (data.categories && data.categories.length > 0 ? await upsertCategories(client, data.categories) : []);
    for (const catId of resolvedCatIds) {
      await client.query(
        `INSERT INTO book_categories (book_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [bookId, catId],
      );
    }

    // Insert tags
    if (data.tags && data.tags.length > 0) {
      for (const tag of data.tags) {
        const t = tag.trim().toLowerCase();
        if (t) {
          await client.query(
            `INSERT INTO book_tags (book_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [bookId, t],
          );
        }
      }
    }

    // Rebuild search_vector (trigger fires on UPDATE; force it)
    await client.query(`UPDATE books SET title = title WHERE id = $1`, [bookId]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'CREATE','book',$3,$4,$5)`,
      [staffCtx.staffId, staffCtx.role, String(bookId), staffCtx.branchId,
       JSON.stringify({ isbn: data.isbn, title: data.title })],
    );

    await client.query('COMMIT');

    const book = await fetchBookById(bookId);
    return book!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateBook(
  id: number,
  data: Partial<BookInput>,
  staffCtx: StaffCtx,
): Promise<BookRecord> {
  const existing = await fetchBookById(id);
  if (!existing) throw new NotFoundError('Book');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Track changed bibliographic fields for edit history
    const trackableFields: Array<keyof BookInput> = [
      'title', 'genre', 'publisher', 'edition', 'language', 'format',
      'description', 'coverImageUrl', 'defaultPrice', 'tradeValue',
    ];

    const dbFieldMap: Record<string, string> = {
      coverImageUrl: 'cover_image_url',
      defaultPrice: 'default_price',
      tradeValue: 'trade_value',
    };

    for (const field of trackableFields) {
      if (!(field in data)) continue;
      const dbField = dbFieldMap[field] ?? field;
      const oldVal = String(((existing as unknown) as Record<string, unknown>)[field] ?? '');
      const newVal = String(((data as unknown) as Record<string, unknown>)[field] ?? '');
      if (oldVal !== newVal) {
        await client.query(
          `INSERT INTO book_edit_history (book_id, field_name, old_value, new_value, changed_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, dbField, oldVal, newVal, staffCtx.staffId],
        );
      }
    }

    // Build SET clause for scalar fields
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    const scalarMap: Record<string, string> = {
      title: 'title', genre: 'genre', publisher: 'publisher', publisherId: 'publisher_id',
      formatId: 'format_id', editionId: 'edition_id',
      edition: 'edition', language: 'language', format: 'format', description: 'description',
      coverImageUrl: 'cover_image_url', defaultPrice: 'default_price', tradeValue: 'trade_value',
      sku: 'sku',
    };

    for (const [jsKey, dbCol] of Object.entries(scalarMap)) {
      if (jsKey in data) {
        setClauses.push(`${dbCol} = $${paramIdx++}`);
        params.push((data as Record<string, unknown>)[jsKey] ?? null);
      }
    }

    if (setClauses.length > 0) {
      params.push(id);
      await client.query(
        `UPDATE books SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
        params,
      );
    }

    // Update authors if provided (prefer authorIds, fall back to names)
    const hasAuthorUpdate = data.authorIds !== undefined || data.authors !== undefined;
    if (hasAuthorUpdate) {
      await client.query(`DELETE FROM book_authors WHERE book_id = $1`, [id]);
      const resolvedIds: number[] = data.authorIds && data.authorIds.length > 0
        ? data.authorIds
        : (data.authors && data.authors.length > 0 ? await upsertAuthors(client, data.authors) : []);
      for (let i = 0; i < resolvedIds.length; i++) {
        await client.query(
          `INSERT INTO book_authors (book_id, author_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, resolvedIds[i], i],
        );
      }
    }

    // Update categories if provided (prefer categoryIds, fall back to names)
    const hasCatUpdate = data.categoryIds !== undefined || data.categories !== undefined;
    if (hasCatUpdate) {
      await client.query(`DELETE FROM book_categories WHERE book_id = $1`, [id]);
      const resolvedCatIds: number[] = data.categoryIds && data.categoryIds.length > 0
        ? data.categoryIds
        : (data.categories && data.categories.length > 0 ? await upsertCategories(client, data.categories) : []);
      for (const catId of resolvedCatIds) {
        await client.query(
          `INSERT INTO book_categories (book_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, catId],
        );
      }
    }

    // Update tags if provided
    if (data.tags !== undefined) {
      await client.query(`DELETE FROM book_tags WHERE book_id = $1`, [id]);
      for (const tag of data.tags) {
        const t = tag.trim().toLowerCase();
        if (t) {
          await client.query(
            `INSERT INTO book_tags (book_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, t],
          );
        }
      }
    }

    // Rebuild search_vector
    await client.query(`UPDATE books SET title = title WHERE id = $1`, [id]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'UPDATE','book',$3,$4,$5)`,
      [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId,
       JSON.stringify({ updatedFields: Object.keys(data) })],
    );

    await client.query('COMMIT');
    return (await fetchBookById(id))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Deactivate ────────────────────────────────────────────────────────────────

export async function deactivateBook(id: number, staffCtx: StaffCtx): Promise<void> {
  const result = await db.query(
    `UPDATE books SET is_active = false WHERE id = $1 RETURNING id`,
    [id],
  );
  if (result.rows.length === 0) throw new NotFoundError('Book');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1,$2,'UPDATE','book',$3,$4,$5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId,
     JSON.stringify({ action: 'deactivated' })],
  );
}

// ── Reactivate ────────────────────────────────────────────────────────────────

export async function reactivateBook(id: number, staffCtx: StaffCtx): Promise<void> {
  const result = await db.query(
    `UPDATE books SET is_active = true WHERE id = $1 RETURNING id`,
    [id],
  );
  if (result.rows.length === 0) throw new NotFoundError('Book');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1,$2,'UPDATE','book',$3,$4,$5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId,
     JSON.stringify({ action: 'reactivated' })],
  );
}

// ── Get by ID ─────────────────────────────────────────────────────────────────

export async function getBookById(id: number, branchId?: number): Promise<BookRecord> {
  const book = await fetchBookById(id, branchId);
  if (!book) throw new NotFoundError('Book');
  return book;
}

// ── Set branch price ──────────────────────────────────────────────────────────

export async function setBranchPrice(
  bookId: number,
  branchId: number,
  price: number,
  staffCtx: StaffCtx,
): Promise<void> {
  const bookCheck = await db.query(`SELECT id FROM books WHERE id = $1`, [bookId]);
  if (bookCheck.rows.length === 0) throw new NotFoundError('Book');

  await db.query(
    `INSERT INTO book_branch_prices (book_id, branch_id, price, format_id, edition_id)
     VALUES ($1,$2,$3,0,0)
     ON CONFLICT (book_id, branch_id, format_id, edition_id) DO UPDATE SET price = EXCLUDED.price`,
    [bookId, branchId, price],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1,$2,'UPDATE','book_price',$3,$4,$5)`,
    [staffCtx.staffId, staffCtx.role, String(bookId), branchId,
     JSON.stringify({ branchId, price })],
  );
}

// ── Get effective price ───────────────────────────────────────────────────────

export async function getEffectivePrice(bookId: number, branchId: number): Promise<number | null> {
  const result = await db.query(
    `SELECT COALESCE(bbp.price, b.default_price) AS price
     FROM books b
     LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = $2
     WHERE b.id = $1`,
    [bookId, branchId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].price != null ? parseFloat(result.rows[0].price as string) : null;
}

// ── Search ────────────────────────────────────────────────────────────────────
// Full-text search via tsvector (title + authors). Supports:
//   - ?q: full-text query
//   - ?isbn: exact match
//   - ?genre, ?category, ?tag: filter
//   - ?isActive: filter (default true)
//   - ?branchId: include branch price in results
//   - ?sortBy, ?sortDir, ?page, ?pageSize: pagination

export async function searchBooks(filters: SearchFilters): Promise<{
  items: BookRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  // Full-text search — covers title, author name, SKU via OR
  if (filters.q) {
    const q = filters.q.trim();
    conditions.push(`(
      lower(b.title) LIKE lower($${p}) OR
      lower(COALESCE(b.sku, '')) LIKE lower($${p}) OR
      EXISTS (
        SELECT 1 FROM book_authors ba_q
        JOIN authors a_q ON a_q.id = ba_q.author_id
        WHERE ba_q.book_id = b.id AND lower(a_q.name) LIKE lower($${p})
      )
    )`);
    params.push(`%${q}%`);
    p += 1;
  }

  // Exact ISBN (strip dashes/spaces)
  if (filters.isbn) {
    conditions.push(`b.isbn = $${p++}`);
    params.push(filters.isbn.replace(/[-\s]/g, ''));
  }

  // SKU partial match
  if (filters.sku) {
    conditions.push(`lower(b.sku) LIKE lower($${p++})`);
    params.push(`%${filters.sku.trim()}%`);
  }

  // Author partial match via JOIN
  if (filters.author) {
    conditions.push(`EXISTS (
      SELECT 1 FROM book_authors ba2
      JOIN authors a2 ON a2.id = ba2.author_id
      WHERE ba2.book_id = b.id AND lower(a2.name) LIKE lower($${p++})
    )`);
    params.push(`%${filters.author.trim()}%`);
  }

  // Genre exact match (case-insensitive)
  if (filters.genre) {
    conditions.push(`lower(b.genre) = lower($${p++})`);
    params.push(filters.genre);
  }

  // Category via JOIN
  if (filters.category) {
    conditions.push(`EXISTS (
      SELECT 1 FROM book_categories bc2
      JOIN categories c2 ON c2.id = bc2.category_id
      WHERE bc2.book_id = b.id AND lower(c2.name) = lower($${p++})
    )`);
    params.push(filters.category);
  }

  // Tag via JOIN
  if (filters.tag) {
    conditions.push(`EXISTS (
      SELECT 1 FROM book_tags bt2
      WHERE bt2.book_id = b.id AND lower(bt2.tag) = lower($${p++})
    )`);
    params.push(filters.tag);
  }

  // Active filter — only applied when explicitly set
  if (filters.isActive !== undefined) {
    conditions.push(`b.is_active = $${p++}`);
    params.push(filters.isActive);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  const sortableColumns: Record<string, string> = {
    title: 'b.title',
    isbn: 'b.isbn',
    created_at: 'b.created_at',
    default_price: 'b.default_price',
  };
  const sortCol = sortableColumns[filters.sortBy ?? 'title'] ?? 'b.title';
  const sortDir = filters.sortDir === 'desc' ? 'DESC' : 'ASC';

  // Count query
  const countResult = await db.query(
    `SELECT COUNT(DISTINCT b.id) FROM books b ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count as string, 10);

  // Data query — aggregate authors, categories, tags per book
  // p is the next available param index after all WHERE conditions.
  // We need: locationId ($p), branchId ($p+1), branchId ($p+2), branchId ($p+3), pageSize ($p+4), offset ($p+5)
  const locParam    = p;       // $p   — locationId (for specific-location stock)
  const branchParam = p + 1;   // $p+1 — branchId (for branch-wide stock)
  const bbpParam    = p + 2;   // $p+2 — branchId (for branch price join)
  const limitParam  = p + 3;   // $p+3 — pageSize
  const offsetParam = p + 4;   // $p+4 — offset

  const dataResult = await db.query(
    `SELECT
       b.id, b.isbn, b.sku, b.title, b.genre, b.publisher, b.publisher_id,
       b.edition, b.language, b.format, b.description, b.cover_image_url,
       b.default_price, b.trade_value, b.is_active, b.created_at,
       b.format_id, bf.code AS format_code, bf.label AS format_label,
       b.edition_id, be.code AS edition_code, be.label AS edition_label,
       COALESCE(
         ARRAY_AGG(DISTINCT a.name ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL),
         '{}'
       ) AS authors,
       COALESCE(
         ARRAY_AGG(a.id ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL),
         '{}'
       ) AS author_ids,
       COALESCE(
         ARRAY_AGG(DISTINCT c.name ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
         '{}'
       ) AS categories,
       COALESCE(
         ARRAY_AGG(c.id ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
         '{}'
       ) AS category_ids,
       COALESCE(
         ARRAY_AGG(DISTINCT bt.tag ORDER BY bt.tag) FILTER (WHERE bt.tag IS NOT NULL),
         '{}'
       ) AS tags,
       bbp.price AS branch_price,
       (
         SELECT COALESCE(SUM(inv.quantity), 0)
              - COALESCE((
                  SELECT SUM(r.quantity) FROM inventory_reservations r
                  WHERE r.book_id = b.id AND r.status = 'reserved'
                    AND CASE
                      WHEN $${locParam}::integer IS NOT NULL THEN r.location_id = $${locParam}::integer
                      WHEN $${branchParam}::integer IS NOT NULL THEN r.location_id IN (
                        SELECT id FROM locations WHERE branch_id = $${branchParam}::integer
                      )
                      ELSE false END
                ), 0)
         FROM inventory inv
         WHERE inv.book_id = b.id
           AND CASE
             WHEN $${locParam}::integer IS NOT NULL THEN inv.location_id = $${locParam}::integer
             WHEN $${branchParam}::integer IS NOT NULL THEN inv.location_id IN (
               SELECT id FROM locations WHERE branch_id = $${branchParam}::integer
             )
             ELSE false
           END
       ) AS stock_quantity
     FROM books b
     LEFT JOIN book_formats bf ON bf.id = b.format_id
     LEFT JOIN book_editions be ON be.id = b.edition_id
     LEFT JOIN book_authors ba ON ba.book_id = b.id
     LEFT JOIN authors a ON a.id = ba.author_id
     LEFT JOIN book_categories bc ON bc.book_id = b.id
     LEFT JOIN categories c ON c.id = bc.category_id
     LEFT JOIN book_tags bt ON bt.book_id = b.id
     LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = $${bbpParam}::integer
       AND bbp.format_id = 0 AND bbp.edition_id = 0
     ${whereClause}
     GROUP BY b.id, bf.code, bf.label, be.code, be.label, bbp.price
     ORDER BY ${sortCol} ${sortDir}
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...params, filters.locationId ?? null, filters.branchId ?? null, filters.branchId ?? null, pageSize, offset],
  );

  return {
    items: dataResult.rows.map(mapBook),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── Get edit history ──────────────────────────────────────────────────────────

export async function getBookEditHistory(
  bookId: number,
  page = 1,
  pageSize = 25,
): Promise<{ items: unknown[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM book_edit_history WHERE book_id = $1`, [bookId]),
    db.query(
      `SELECT beh.*, s.username AS changed_by_username
       FROM book_edit_history beh
       LEFT JOIN staff s ON s.id = beh.changed_by
       WHERE beh.book_id = $1
       ORDER BY beh.changed_at DESC
       LIMIT $2 OFFSET $3`,
      [bookId, pageSize, offset],
    ),
  ]);
  return {
    items: dataRes.rows,
    total: parseInt(countRes.rows[0].count as string, 10),
  };
}

// ── Autocomplete helpers ──────────────────────────────────────────────────────
// Used by UI for author/category suggestions.

export async function suggestAuthors(prefix: string, limit = 10): Promise<string[]> {
  const result = await db.query(
    `SELECT name FROM authors
     WHERE normalized_name LIKE lower($1) || '%'
     ORDER BY name ASC LIMIT $2`,
    [prefix.trim(), limit],
  );
  return result.rows.map(r => r.name as string);
}

export async function suggestCategories(prefix: string, limit = 10): Promise<string[]> {
  const result = await db.query(
    `SELECT name FROM categories
     WHERE normalized_name LIKE lower($1) || '%'
     ORDER BY name ASC LIMIT $2`,
    [prefix.trim(), limit],
  );
  return result.rows.map(r => r.name as string);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER DATA — Authors, Categories, Publishers
// ═══════════════════════════════════════════════════════════════════════════════

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthorRecord {
  id: number;
  name: string;
  normalizedName: string;
  createdAt: string;
  bookCount?: number;
}

export interface CategoryRecord {
  id: number;
  name: string;
  normalizedName: string;
  parentId: number | null;
  parentName?: string | null;
  createdAt: string;
  bookCount?: number;
}

export interface PublisherRecord {
  id: number;
  name: string;
  createdAt: string;
  bookCount?: number;
}

// ── Authors CRUD ──────────────────────────────────────────────────────────────

export async function listAuthors(opts: {
  q?: string; page?: number; pageSize?: number;
}): Promise<{ items: AuthorRecord[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [];
  let where = '';
  if (opts.q) {
    where = `WHERE normalized_name LIKE lower($1) || '%'`;
    params.push(opts.q.trim());
  }
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM authors ${where}`, params),
    db.query(
      `SELECT a.id, a.name, a.normalized_name, a.created_at,
              COUNT(ba.book_id)::int AS book_count
       FROM authors a
       LEFT JOIN book_authors ba ON ba.author_id = a.id
       ${where}
       GROUP BY a.id
       ORDER BY a.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  return {
    total: parseInt(countRes.rows[0].count as string, 10),
    items: dataRes.rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      normalizedName: r.normalized_name as string,
      createdAt: (r.created_at as Date).toISOString(),
      bookCount: r.book_count as number,
    })),
  };
}

export async function createAuthor(name: string, staffCtx: StaffCtx): Promise<AuthorRecord> {
  const normalized = name.trim().toLowerCase();
  if (!normalized) throw new ValidationError('Author name is required');
  try {
    const result = await db.query(
      `INSERT INTO authors (name, normalized_name) VALUES ($1, $2) RETURNING *`,
      [name.trim(), normalized],
    );
    await db.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'CREATE','author',$3,$4,$5)`,
      [staffCtx.staffId, staffCtx.role, String(result.rows[0].id), staffCtx.branchId, JSON.stringify({ name })],
    );
    return { id: result.rows[0].id, name: result.rows[0].name, normalizedName: result.rows[0].normalized_name, createdAt: result.rows[0].created_at.toISOString() };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError('DUPLICATE_AUTHOR', `Author '${name}' already exists`);
    throw err;
  }
}

export async function updateAuthor(id: number, name: string, staffCtx: StaffCtx): Promise<AuthorRecord> {
  const normalized = name.trim().toLowerCase();
  try {
    const result = await db.query(
      `UPDATE authors SET name=$1, normalized_name=$2 WHERE id=$3 RETURNING *`,
      [name.trim(), normalized, id],
    );
    if (!result.rows.length) throw new NotFoundError('Author');
    await db.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'UPDATE','author',$3,$4,$5)`,
      [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ name })],
    );
    return { id: result.rows[0].id, name: result.rows[0].name, normalizedName: result.rows[0].normalized_name, createdAt: result.rows[0].created_at.toISOString() };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError('DUPLICATE_AUTHOR', `Author '${name}' already exists`);
    throw err;
  }
}

export async function deleteAuthor(id: number, staffCtx: StaffCtx): Promise<void> {
  const check = await db.query(`SELECT COUNT(*) FROM book_authors WHERE author_id=$1`, [id]);
  if (parseInt(check.rows[0].count as string, 10) > 0) {
    throw new ConflictError('AUTHOR_IN_USE', 'Author is linked to one or more books');
  }
  const result = await db.query(`DELETE FROM authors WHERE id=$1 RETURNING id`, [id]);
  if (!result.rows.length) throw new NotFoundError('Author');
  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1,$2,'DELETE','author',$3,$4,'{}')`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId],
  );
}

// ── Categories CRUD ───────────────────────────────────────────────────────────

export async function listCategories(opts: {
  q?: string; page?: number; pageSize?: number;
}): Promise<{ items: CategoryRecord[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, opts.pageSize ?? 100);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [];
  let where = '';
  if (opts.q) {
    where = `WHERE c.normalized_name LIKE lower($1) || '%'`;
    params.push(opts.q.trim());
  }
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM categories c ${where}`, params),
    db.query(
      `SELECT c.id, c.name, c.normalized_name, c.parent_id, c.created_at,
              p.name AS parent_name,
              COUNT(bc.book_id)::int AS book_count
       FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       LEFT JOIN book_categories bc ON bc.category_id = c.id
       ${where}
       GROUP BY c.id, p.name
       ORDER BY c.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  return {
    total: parseInt(countRes.rows[0].count as string, 10),
    items: dataRes.rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      normalizedName: r.normalized_name as string,
      parentId: (r.parent_id as number | null) ?? null,
      parentName: (r.parent_name as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      bookCount: r.book_count as number,
    })),
  };
}

export async function createCategory(data: { name: string; parentId?: number | null }, staffCtx: StaffCtx): Promise<CategoryRecord> {
  const normalized = data.name.trim().toLowerCase();
  if (!normalized) throw new ValidationError('Category name is required');
  try {
    const result = await db.query(
      `INSERT INTO categories (name, normalized_name, parent_id) VALUES ($1,$2,$3) RETURNING *`,
      [data.name.trim(), normalized, data.parentId ?? null],
    );
    await db.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'CREATE','category',$3,$4,$5)`,
      [staffCtx.staffId, staffCtx.role, String(result.rows[0].id), staffCtx.branchId, JSON.stringify(data)],
    );
    return { id: result.rows[0].id, name: result.rows[0].name, normalizedName: result.rows[0].normalized_name, parentId: result.rows[0].parent_id, createdAt: result.rows[0].created_at.toISOString() };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError('DUPLICATE_CATEGORY', `Category '${data.name}' already exists`);
    throw err;
  }
}

export async function updateCategory(id: number, data: { name?: string; parentId?: number | null }, staffCtx: StaffCtx): Promise<CategoryRecord> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (data.name !== undefined) { setClauses.push(`name=$${p++}`, `normalized_name=$${p++}`); params.push(data.name.trim(), data.name.trim().toLowerCase()); }
  if ('parentId' in data) { setClauses.push(`parent_id=$${p++}`); params.push(data.parentId ?? null); }
  if (!setClauses.length) throw new ValidationError('Nothing to update');
  params.push(id);
  try {
    const result = await db.query(`UPDATE categories SET ${setClauses.join(',')} WHERE id=$${p} RETURNING *`, params);
    if (!result.rows.length) throw new NotFoundError('Category');
    return { id: result.rows[0].id, name: result.rows[0].name, normalizedName: result.rows[0].normalized_name, parentId: result.rows[0].parent_id, createdAt: result.rows[0].created_at.toISOString() };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError('DUPLICATE_CATEGORY', `Category '${data.name}' already exists`);
    throw err;
  }
}

export async function deleteCategory(id: number, staffCtx: StaffCtx): Promise<void> {
  const check = await db.query(`SELECT COUNT(*) FROM book_categories WHERE category_id=$1`, [id]);
  if (parseInt(check.rows[0].count as string, 10) > 0) throw new ConflictError('CATEGORY_IN_USE', 'Category is linked to one or more books');
  const result = await db.query(`DELETE FROM categories WHERE id=$1 RETURNING id`, [id]);
  if (!result.rows.length) throw new NotFoundError('Category');
  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1,$2,'DELETE','category',$3,$4,'{}')`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId],
  );
}

// ── Publishers CRUD ───────────────────────────────────────────────────────────

export async function listPublishers(opts: {
  q?: string; page?: number; pageSize?: number;
}): Promise<{ items: PublisherRecord[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const params: unknown[] = [];
  let where = '';
  if (opts.q) { where = `WHERE lower(p.name) LIKE lower($1) || '%'`; params.push(opts.q.trim()); }
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM publishers p ${where}`, params),
    db.query(
      `SELECT p.id, p.name, p.created_at, COUNT(b.id)::int AS book_count
       FROM publishers p
       LEFT JOIN books b ON b.publisher_id = p.id
       ${where}
       GROUP BY p.id
       ORDER BY p.name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  return {
    total: parseInt(countRes.rows[0].count as string, 10),
    items: dataRes.rows.map(r => ({
      id: r.id as number,
      name: r.name as string,
      createdAt: (r.created_at as Date).toISOString(),
      bookCount: r.book_count as number,
    })),
  };
}

export async function createPublisher(name: string, staffCtx: StaffCtx): Promise<PublisherRecord> {
  if (!name.trim()) throw new ValidationError('Publisher name is required');
  try {
    const result = await db.query(`INSERT INTO publishers (name) VALUES ($1) RETURNING *`, [name.trim()]);
    await db.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'CREATE','publisher',$3,$4,$5)`,
      [staffCtx.staffId, staffCtx.role, String(result.rows[0].id), staffCtx.branchId, JSON.stringify({ name })],
    );
    return { id: result.rows[0].id, name: result.rows[0].name, createdAt: result.rows[0].created_at.toISOString() };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError('DUPLICATE_PUBLISHER', `Publisher '${name}' already exists`);
    throw err;
  }
}

export async function updatePublisher(id: number, name: string, staffCtx: StaffCtx): Promise<PublisherRecord> {
  try {
    const result = await db.query(`UPDATE publishers SET name=$1 WHERE id=$2 RETURNING *`, [name.trim(), id]);
    if (!result.rows.length) throw new NotFoundError('Publisher');
    return { id: result.rows[0].id, name: result.rows[0].name, createdAt: result.rows[0].created_at.toISOString() };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError('DUPLICATE_PUBLISHER', `Publisher '${name}' already exists`);
    throw err;
  }
}

export async function deletePublisher(id: number, staffCtx: StaffCtx): Promise<void> {
  const check = await db.query(`SELECT COUNT(*) FROM books WHERE publisher_id=$1`, [id]);
  if (parseInt(check.rows[0].count as string, 10) > 0) throw new ConflictError('PUBLISHER_IN_USE', 'Publisher is linked to one or more books');
  const result = await db.query(`DELETE FROM publishers WHERE id=$1 RETURNING id`, [id]);
  if (!result.rows.length) throw new NotFoundError('Publisher');
  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1,$2,'DELETE','publisher',$3,$4,'{}')`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOK FORMATS & EDITIONS — Lookup tables
// ═══════════════════════════════════════════════════════════════════════════════

export interface BookFormatRecord { id: number; code: string; label: string; sortOrder: number; }
export interface BookEditionRecord { id: number; code: string; label: string; sortOrder: number; }

export async function listBookFormats(): Promise<BookFormatRecord[]> {
  const result = await db.query(`SELECT id, code, label, sort_order FROM book_formats ORDER BY sort_order ASC`);
  return result.rows.map(r => ({ id: r.id as number, code: r.code as string, label: r.label as string, sortOrder: r.sort_order as number }));
}

export async function listBookEditions(): Promise<BookEditionRecord[]> {
  const result = await db.query(`SELECT id, code, label, sort_order FROM book_editions ORDER BY sort_order ASC`);
  return result.rows.map(r => ({ id: r.id as number, code: r.code as string, label: r.label as string, sortOrder: r.sort_order as number }));
}


