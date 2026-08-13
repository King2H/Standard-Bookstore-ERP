import { db } from '../../db/index.js';
import type { BookRecord } from './catalog.service.js';

// ── catalogSearch.service.ts ──────────────────────────────────────────────────
// Shared full-catalog search function for all transactional modules
// (Procurement, StockIn, POS, Orders, Inventory, Returns, Exchanges).
//
// Key differences from catalog.service.ts searchBooks():
//   - NO OFFSET: always scans the entire catalog
//   - Covers 5 fields: title, isbn, sku, publisher (text), author name
//   - Note: barcode column does not exist in this schema — omitted
//   - Default limit 50, max 200
//   - Returns [] immediately for q < 2 chars (no DB round-trip)
//
// Architecture constraint: this is a pure read function — no mutations.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

export interface CatalogSearchOpts {
  branchId?: number;
  limit?: number;
}

/**
 * Search the full catalog without pagination offset.
 *
 * @param q      - Search term. Must be ≥ 2 chars; returns [] otherwise.
 * @param opts   - Optional branchId (for branch price) and result limit.
 * @returns      - Array of BookRecord matching any of the 5 search fields.
 */
export async function search(
  q: string,
  opts: CatalogSearchOpts = {},
): Promise<BookRecord[]> {
  // Guard: empty or too-short query — no DB call
  if (!q || q.trim().length < 2) {
    return [];
  }

  const term = q.trim();
  const likeTerm = `%${term}%`;

  // Clamp limit to [1, MAX_LIMIT]
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, opts.limit ?? DEFAULT_LIMIT),
  );

  // Parameterized query — no string interpolation of user input
  //
  // Fields searched:
  //   1. b.title         — case-insensitive LIKE
  //   2. b.isbn          — LIKE (ISBN may contain digits/hyphens; no case folding needed)
  //   3. b.sku           — case-insensitive LIKE (COALESCE guards NULL)
  //   4. b.publisher     — case-insensitive LIKE on the text column (COALESCE guards NULL)
  //   5. author name     — EXISTS into book_authors + authors (case-insensitive LIKE)
  //
  // Note: barcode column does not exist in this schema, so it is not included.
  //       The publisher text column (b.publisher) satisfies the publisher search
  //       requirement; publisher_id FK is not needed for this search path.
  //
  // NO OFFSET — always scans entire catalog; LIMIT only.

  const result = await db.query(
    `SELECT
       b.id,
       b.isbn,
       b.sku,
       b.title,
       b.genre,
       b.publisher,
       b.publisher_id,
       b.edition,
       b.language,
       b.format,
       b.description,
       b.cover_image_url,
       b.default_price,
       b.trade_value,
       b.is_active,
       b.status,
       b.archived_at,
       b.created_at,
       b.format_id,
       bf.code  AS format_code,
       bf.label AS format_label,
       b.edition_id,
       be.code  AS edition_code,
       be.label AS edition_label,
       COALESCE(
         ARRAY_AGG(DISTINCT a.name  ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL),
         '{}'
       ) AS authors,
       COALESCE(
         ARRAY_AGG(a.id             ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL),
         '{}'
       ) AS author_ids,
       COALESCE(
         ARRAY_AGG(DISTINCT c.name  ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
         '{}'
       ) AS categories,
       COALESCE(
         ARRAY_AGG(c.id             ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
         '{}'
       ) AS category_ids,
       COALESCE(
         ARRAY_AGG(DISTINCT bt.tag  ORDER BY bt.tag) FILTER (WHERE bt.tag IS NOT NULL),
         '{}'
       ) AS tags,
       bbp.price    AS branch_price,
       NULL::int    AS stock_quantity
     FROM books b
     LEFT JOIN book_formats       bf  ON bf.id  = b.format_id
     LEFT JOIN book_editions      be  ON be.id  = b.edition_id
     LEFT JOIN book_authors       ba  ON ba.book_id  = b.id
     LEFT JOIN authors            a   ON a.id   = ba.author_id
     LEFT JOIN book_categories    bc  ON bc.book_id  = b.id
     LEFT JOIN categories         c   ON c.id   = bc.category_id
     LEFT JOIN book_tags          bt  ON bt.book_id  = b.id
     LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id
                                     AND bbp.branch_id = $2
                                     AND bbp.format_id = 0
                                     AND bbp.edition_id = 0
     -- Prompt 3 — explicit status='ACTIVE' alongside the legacy is_active
     -- check: both are kept in lockstep by transitionEntityStatus, but
     -- spelling out status here matches the spec's "operational search
     -- endpoints must default to WHERE status = 'ACTIVE'" requirement
     -- directly rather than relying solely on the derived boolean.
     WHERE b.is_active = true AND b.status = 'ACTIVE'
       AND (
         lower(b.title)                       LIKE lower($1)
         OR b.isbn                            LIKE $1
         OR lower(COALESCE(b.sku,       ''))  LIKE lower($1)
         OR lower(COALESCE(b.publisher, ''))  LIKE lower($1)
         OR EXISTS (
           SELECT 1
           FROM book_authors ba2
           JOIN authors      a2  ON a2.id = ba2.author_id
           WHERE ba2.book_id = b.id
             AND lower(a2.name) LIKE lower($1)
         )
       )
     GROUP BY
       b.id, bf.code, bf.label, be.code, be.label, bbp.price
     ORDER BY b.title ASC
     LIMIT $3`,
    [
      likeTerm,              // $1 — the LIKE pattern (safe parameterised)
      opts.branchId ?? null, // $2 — branch price lookup (NULL = no branch price)
      limit,                 // $3 — LIMIT (no OFFSET)
    ],
  );

  return result.rows.map(mapBookRow);
}

// ── Internal row mapper — matches the BookRecord shape from catalog.service.ts ─

function mapBookRow(row: Record<string, unknown>): BookRecord {
  return {
    id:            row.id as number,
    isbn:          row.isbn as string,
    sku:           (row.sku           as string | null) ?? null,
    title:         row.title as string,
    authors:       (row.authors       as string[] | null) ?? [],
    authorIds:     (row.author_ids    as number[] | null) ?? [],
    genre:         (row.genre         as string | null) ?? null,
    publisher:     (row.publisher     as string | null) ?? null,
    publisherId:   (row.publisher_id  as number | null) ?? null,
    formatId:      (row.format_id     as number | null) ?? null,
    formatCode:    (row.format_code   as string | null) ?? null,
    formatLabel:   (row.format_label  as string | null) ?? null,
    editionId:     (row.edition_id    as number | null) ?? null,
    editionCode:   (row.edition_code  as string | null) ?? null,
    editionLabel:  (row.edition_label as string | null) ?? null,
    edition:       (row.edition       as string | null) ?? null,
    language:      (row.language      as string | null) ?? null,
    format:        (row.format        as string | null) ?? null,
    description:   (row.description   as string | null) ?? null,
    coverImageUrl: (row.cover_image_url as string | null) ?? null,
    defaultPrice:  row.default_price != null ? parseFloat(row.default_price as string) : null,
    tradeValue:    row.trade_value    != null ? parseFloat(row.trade_value   as string) : null,
    isActive:      row.is_active as boolean,
    status:        (row.status as 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | undefined) ?? (row.is_active ? 'ACTIVE' : 'INACTIVE'),
    archivedAt:    row.archived_at ? (row.archived_at as Date).toISOString() : null,
    createdAt:     (row.created_at as Date).toISOString(),
    categories:    (row.categories    as string[] | null) ?? [],
    categoryIds:   (row.category_ids  as number[] | null) ?? [],
    tags:          (row.tags          as string[] | null) ?? [],
    branchPrice:   row.branch_price   != null ? parseFloat(row.branch_price as string) : null,
    stockQuantity: row.stock_quantity != null
      ? Math.max(0, parseInt(row.stock_quantity as string, 10))
      : null,
  };
}
