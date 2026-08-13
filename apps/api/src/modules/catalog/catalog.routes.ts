import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import * as catalogService from './catalog.service.js';
import * as catalogSearchService from './catalogSearch.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole, requirePermission } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { getBookAvailability } from '../inventory/inventoryTransaction.service.js';
import { paramInt } from '../../lib/http.js';
import type { LifecycleStatus } from '../../lib/lifecycle.js';

const router = Router();

// Helper: safely extract a single string from req.query (handles string | string[] | ParsedQs)
const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const qi = (v: unknown, fallback?: number): number | undefined => {
  const s = qs(v);
  if (!s) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && !Number.isNaN(n) ? n : fallback;
};
const qid = (v: unknown, fallback: number): number => qi(v, fallback) ?? fallback;

// Tri-state is_active resolver shared by /books and /books/with-availability:
// omitted -> true (active-only default — a deactivated book must stay out of
// the default listing/search); 'true'/'false' -> exact filter; 'all' -> no
// filter (both). Bug fix: the Catalog UI's "All" status option used to send
// no is_active param at all, which fell through to the same default as an
// omitted param and silently filtered to active-only — "All" never actually
// showed inactive books. searchBooks() already treats `isActive: undefined`
// as "no filter"; the bug was that this endpoint had no way to reach that
// state on purpose. 'all' is that explicit signal.
function resolveIsActiveFilter(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return true;
  if (raw === 'all') return undefined;
  return raw === 'true';
}

// Prompt 3 — Master Data Lifecycle: the shared status-filter resolver behind
// every master-data list endpoint's `?status=` query param (the frontend's
// StatusFilter component sends exactly these four values). Default (param
// omitted) is ACTIVE-only, per the spec's "Default filter = Active."
// 'all' returns undefined (no filter) so callers who want every status can
// still tell that apart from "unrecognized value, fall back to safe default".
function resolveStatusFilter(raw: string | undefined): LifecycleStatus[] | undefined {
  const v = (raw ?? 'active').toLowerCase();
  if (v === 'all') return undefined;
  if (v === 'inactive') return ['INACTIVE'];
  if (v === 'archived') return ['ARCHIVED'];
  return ['ACTIVE'];
}

// ── Validation schemas ────────────────────────────────────────────────────────

const bookWriteSchema = z.object({
  isbn:          z.string().min(10).max(17).optional().or(z.literal('')),
  sku:           z.string().max(100).optional(),
  title:         z.string().min(1).max(500),
  authors:       z.array(z.string().min(1)).default([]),
  authorIds:     z.array(z.number().int().positive()).optional(),
  genre:         z.string().max(100).optional(),
  publisher:     z.string().max(200).optional(),
  publisherId:   z.number().int().positive().nullable().optional(),
  formatId:      z.number().int().positive().nullable().optional(),
  editionId:     z.number().int().positive().nullable().optional(),
  edition:       z.string().max(50).optional(),
  language:      z.string().max(50).optional(),
  format:        z.string().max(50).optional(),
  description:   z.string().max(5000).optional(),
  coverImageUrl: z.string().url().optional().or(z.literal('')),
  defaultPrice:  z.number().nonnegative().optional(),
  tradeValue:    z.number().nonnegative().optional(),
  categories:    z.array(z.string().min(1)).optional(),
  categoryIds:   z.array(z.number().int().positive()).optional(),
  tags:          z.array(z.string().min(1)).optional(),
});

const bookUpdateSchema = bookWriteSchema.partial().omit({ isbn: true });

// Non-Destructive Catalog Search & Virtual Receiving: a lightweight subset of
// bookWriteSchema for the Exchange screen's "Quick Catalog Register" modal —
// just enough to create a searchable catalog entry (ISBN/Barcode, Title,
// Author, Base List Price) without leaving the Exchange flow. Reuses
// catalogService.createBook() itself (same INSERT, same is_active=true
// default, same duplicate-ISBN handling) — this is metadata registration
// only, it never touches inventory.
const quickRegisterSchema = z.object({
  isbn:         z.string().min(10).max(17).optional().or(z.literal('')),
  title:        z.string().min(1).max(500),
  author:       z.string().max(200).optional().or(z.literal('')),
  defaultPrice: z.number().nonnegative().optional(),
});

const priceSchema = z.object({
  price: z.number().nonnegative(),
});

// ── GET /api/books ────────────────────────────────────────────────────────────

router.get(
  '/books',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await catalogService.searchBooks({
        q:          qs(req.query.q),
        isbn:       qs(req.query.isbn),
        sku:        qs(req.query.sku),
        author:     qs(req.query.author),
        genre:      qs(req.query.genre),
        category:   qs(req.query.category),
        tag:        qs(req.query.tag),
        // See resolveIsActiveFilter() above: defaults to active-only,
        // matching /books/with-availability below; ?is_active=false shows
        // only inactive books; ?is_active=all shows both.
        isActive:   resolveIsActiveFilter(qs(req.query.is_active)),
        // Prompt 3 — only set when the caller actually sends ?status=
        // (the Catalog admin page's new StatusFilter). Left undefined for
        // every other existing caller so the isActive fallback above keeps
        // behaving exactly as before.
        status:     qs(req.query.status) !== undefined ? resolveStatusFilter(qs(req.query.status)) : undefined,
        // Use explicit query param if provided, otherwise fall back to the JWT branch
        // so stock quantities are always scoped to the user's active branch.
        branchId:   qi(req.query.branchId) ?? req.staff?.branchId,
        locationId: qi(req.query.locationId),
        sortBy:     qs(req.query.sortBy) as catalogService.SearchFilters['sortBy'],
        sortDir:    qs(req.query.sortDir) as 'asc' | 'desc' | undefined,
        page:       qid(req.query.page, 1),
        pageSize:   qid(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/books/with-availability ─────────────────────────────────────────
// Used by POS, Orders, and Exchanges to search books and display live stock.
// Fetches book metadata from Catalog (zero inventory dependency) then enriches
// with availability from inventoryTransaction.service.ts for the given location.
//
// Query params:
//   All params from GET /api/books (q, isbn, branchId, page, pageSize, etc.)
//   + locationId (required for availability — if omitted, availability is null)
//
// Response adds to each BookRecord:
//   availability: { locationId, locationName, onHand, reserved, available } | null

router.get(
  '/books/with-availability',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const locationId = qi(req.query.locationId);
      const branchId   = qi(req.query.branchId) ?? req.staff?.branchId;

      // Step 1: Pure catalog search — no inventory dependency
      const catalogResult = await catalogService.searchBooks({
        q:          qs(req.query.q),
        isbn:       qs(req.query.isbn),
        sku:        qs(req.query.sku),
        author:     qs(req.query.author),
        genre:      qs(req.query.genre),
        category:   qs(req.query.category),
        tag:        qs(req.query.tag),
        isActive:   resolveIsActiveFilter(qs(req.query.is_active)),
        branchId,
        sortBy:     qs(req.query.sortBy) as catalogService.SearchFilters['sortBy'],
        sortDir:    qs(req.query.sortDir) as 'asc' | 'desc' | undefined,
        page:       qid(req.query.page, 1),
        pageSize:   qid(req.query.pageSize, 25),
      });

      // Step 2: Enrich with availability data from inventory (only if locationId given)
      let availabilityMap: Map<number, { locationId: number; locationName: string; onHand: number; reserved: number; available: number }> = new Map();

      if (locationId && catalogResult.items.length > 0) {
        const bookIds = catalogResult.items.map(b => b.id);
        try {
          const avail = await getBookAvailability(bookIds, locationId);
          for (const a of avail) {
            availabilityMap.set(a.bookId, {
              locationId:   a.locationId,
              locationName: a.locationName,
              onHand:       a.onHand,
              reserved:     a.reserved,
              available:    a.available,
            });
          }
        } catch {
          // Non-fatal: if inventory lookup fails, return books with null availability
        }
      }

      // Step 3: Merge and return enriched response
      const items = catalogResult.items.map(book => ({
        ...book,
        availability: availabilityMap.get(book.id) ?? (locationId ? {
          locationId,
          locationName: null,
          onHand: 0,
          reserved: 0,
          available: 0,
        } : null),
      }));

      res.json({ ...catalogResult, items });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/books ───────────────────────────────────────────────────────────

router.post(
  '/books',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = bookWriteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid book payload', { issues: parsed.error.issues });
      }
      const book = await catalogService.createBook({ ...parsed.data, isbn: parsed.data.isbn ?? '' }, req.staff!);
      res.status(201).json(book);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/books/quick-register ────────────────────────────────────────────
// Non-Destructive Catalog Search & Virtual Receiving: lets Sales register a
// catalog-only entry for a book that's never been in the Catalog, without
// leaving the Exchange screen — gated by CREATE_SALE (the same permission
// Exchange creation itself requires), deliberately looser than POST /books'
// Admin/Manager/Stock_Clerk role gate, and deliberately narrow (no genre,
// publisher, categories, etc. — those can be filled in later via full Catalog
// management by staff who have that access). Creates catalog metadata only;
// does NOT touch inventory (mirrors catalogService.createBook() exactly).

router.post(
  '/books/quick-register',
  authenticate,
  requirePermission('CREATE_SALE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = quickRegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid quick-register payload', { issues: parsed.error.issues });
      }
      const { isbn, title, author, defaultPrice } = parsed.data;
      const book = await catalogService.createBook(
        { isbn: isbn ?? '', title, authors: author ? [author] : [], defaultPrice },
        req.staff!,
      );
      res.status(201).json(book);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/books/:id ────────────────────────────────────────────────────────

router.get(
  '/books/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const branchId = req.query.branchId
        ? qi(req.query.branchId, 0)
        : req.staff!.branchId;
      const book = await catalogService.getBookById(id, branchId);
      res.json(book);
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/books/:id ────────────────────────────────────────────────────────

router.put(
  '/books/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const parsed = bookUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid book payload', { issues: parsed.error.issues });
      }
      const book = await catalogService.updateBook(id, parsed.data, req.staff!);
      res.json(book);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/books/:id/deactivate ────────────────────────────────────────────

router.post(
  '/books/:id/deactivate',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      await catalogService.deactivateBook(id, req.staff!);
      res.json({ message: 'Book deactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/books/:id/reactivate ───────────────────────────────────────────

router.post(
  '/books/:id/reactivate',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      await catalogService.reactivateBook(id, req.staff!);
      res.json({ message: 'Book reactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── Prompt 3 — Master Data Lifecycle: archive/restore/usage/delete ───────────

router.post(
  '/books/:id/archive',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      await catalogService.archiveBook(id, req.staff!);
      res.json({ message: 'Book archived' });
    } catch (err) { next(err); }
  },
);

router.post(
  '/books/:id/restore',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      await catalogService.restoreBook(id, req.staff!);
      res.json({ message: 'Book restored' });
    } catch (err) { next(err); }
  },
);

router.get(
  '/catalog/:id/usage',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const usage = await catalogService.getBookUsage(id);
      res.json(usage);
    } catch (err) { next(err); }
  },
);

router.delete(
  '/books/:id',
  authenticate,
  requireRole('Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      await catalogService.deleteBook(id, req.staff!);
      res.json({ message: 'Book deleted' });
    } catch (err) { next(err); }
  },
);

// ── GET /api/books/:id/history ────────────────────────────────────────────────

router.get(
  '/books/:id/history',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const page = qi(req.query.page, 1);
      const pageSize = qi(req.query.pageSize, 25);
      const history = await catalogService.getBookEditHistory(id, page, pageSize);
      res.json(history);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/books/:id/prices ─────────────────────────────────────────────────

router.get(
  '/books/:id/prices',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const result = await db_query_prices(id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/books/:id/prices/:branchId ───────────────────────────────────────

router.put(
  '/books/:id/prices/:branchId',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bookId = paramInt(req.params.id);
      const branchId = paramInt(req.params.branchId);
      const parsed = priceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid price payload', { issues: parsed.error.issues });
      }
      await catalogService.setBranchPrice(bookId, branchId, parsed.data.price, req.staff!);
      res.json({ message: 'Branch price updated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/catalog/search ───────────────────────────────────────────────────
// Full-catalog search endpoint — no pagination offset.
// MUST be defined before any /:id param routes to avoid param capture.
//
// Query params:
//   q        (required, min 2 chars) — search term
//   limit    (optional, max 200, default 50)
//   branchId (optional)
//
// Response: { results: BookRecord[], total: number }
// HTTP 400 if q is missing or q.length < 2
// HTTP 200 with { results: [], total: 0 } when no matches (never an error)

router.get(
  '/catalog/search',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = qs(req.query.q);

      // Validate q: required, minimum 2 characters
      if (!q || q.trim().length < 2) {
        throw new ValidationError(
          'Query parameter "q" is required and must be at least 2 characters',
          { param: 'q' },
        );
      }

      const limit    = qi(req.query.limit) ?? 50;
      const branchId = qi(req.query.branchId) ?? req.staff?.branchId;

      const results = await catalogSearchService.search(q, {
        limit:    Math.min(200, Math.max(1, limit)),
        branchId: branchId,
      });

      res.json({ results, total: results.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/catalog/authors/suggest ─────────────────────────────────────────

router.get(
  '/catalog/authors/suggest',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prefix = qs(req.query.q) ?? '';
      const suggestions = await catalogService.suggestAuthors(prefix);
      res.json({ items: suggestions });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/catalog/categories/suggest ──────────────────────────────────────

router.get(
  '/catalog/categories/suggest',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prefix = qs(req.query.q) ?? '';
      const suggestions = await catalogService.suggestCategories(prefix);
      res.json({ items: suggestions });
    } catch (err) {
      next(err);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER DATA ROUTES — Authors, Categories, Publishers
// ═══════════════════════════════════════════════════════════════════════════════

const nameSchema = z.object({ name: z.string().min(1).max(300) });
const categoryWriteSchema = z.object({
  name: z.string().min(1).max(300),
  parentId: z.number().int().positive().nullable().optional(),
});

// ── Authors ───────────────────────────────────────────────────────────────────

router.get('/authors', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await catalogService.listAuthors({
      q: qs(req.query.q),
      page: qi(req.query.page, 1),
      pageSize: qi(req.query.pageSize, 50),
      status: resolveStatusFilter(qs(req.query.status)),
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/authors', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const author = await catalogService.createAuthor(parsed.data.name, req.staff!);
      res.status(201).json(author);
    } catch (err) { next(err); }
  },
);

router.put('/authors/:id', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params['id'] as string, 10);
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const author = await catalogService.updateAuthor(id, parsed.data.name, req.staff!);
      res.json(author);
    } catch (err) { next(err); }
  },
);

router.delete('/authors/:id', authenticate, requireRole('Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deleteAuthor(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Author deleted' });
    } catch (err) { next(err); }
  },
);

router.get('/authors/:id/usage', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usage = await catalogService.getAuthorUsage(parseInt(req.params['id'] as string, 10));
      res.json(usage);
    } catch (err) { next(err); }
  },
);

router.post('/authors/:id/archive', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.archiveAuthor(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Author archived' });
    } catch (err) { next(err); }
  },
);

router.post('/authors/:id/restore', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.restoreAuthor(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Author restored' });
    } catch (err) { next(err); }
  },
);

router.post('/authors/:id/deactivate', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deactivateAuthor(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Author set inactive' });
    } catch (err) { next(err); }
  },
);

router.post('/authors/:id/activate', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.activateAuthor(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Author activated' });
    } catch (err) { next(err); }
  },
);

// ── Categories ────────────────────────────────────────────────────────────────

router.get('/categories', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await catalogService.listCategories({
      q: qs(req.query.q),
      page: qi(req.query.page, 1),
      pageSize: qi(req.query.pageSize, 100),
      status: resolveStatusFilter(qs(req.query.status)),
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/categories', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = categoryWriteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const cat = await catalogService.createCategory(parsed.data, req.staff!);
      res.status(201).json(cat);
    } catch (err) { next(err); }
  },
);

router.put('/categories/:id', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params['id'] as string, 10);
      const parsed = categoryWriteSchema.partial().safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const cat = await catalogService.updateCategory(id, parsed.data, req.staff!);
      res.json(cat);
    } catch (err) { next(err); }
  },
);

router.delete('/categories/:id', authenticate, requireRole('Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deleteCategory(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Category deleted' });
    } catch (err) { next(err); }
  },
);

router.get('/categories/:id/usage', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usage = await catalogService.getCategoryUsage(parseInt(req.params['id'] as string, 10));
      res.json(usage);
    } catch (err) { next(err); }
  },
);

router.post('/categories/:id/archive', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.archiveCategory(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Category archived' });
    } catch (err) { next(err); }
  },
);

router.post('/categories/:id/restore', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.restoreCategory(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Category restored' });
    } catch (err) { next(err); }
  },
);

router.post('/categories/:id/deactivate', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deactivateCategory(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Category set inactive' });
    } catch (err) { next(err); }
  },
);

router.post('/categories/:id/activate', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.activateCategory(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Category activated' });
    } catch (err) { next(err); }
  },
);

// ── Publishers ────────────────────────────────────────────────────────────────

router.get('/publishers', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await catalogService.listPublishers({
      q: qs(req.query.q),
      page: qi(req.query.page, 1),
      pageSize: qi(req.query.pageSize, 50),
      status: resolveStatusFilter(qs(req.query.status)),
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/publishers', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const pub = await catalogService.createPublisher(parsed.data.name, req.staff!);
      res.status(201).json(pub);
    } catch (err) { next(err); }
  },
);

router.put('/publishers/:id', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params['id'] as string, 10);
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const pub = await catalogService.updatePublisher(id, parsed.data.name, req.staff!);
      res.json(pub);
    } catch (err) { next(err); }
  },
);

router.delete('/publishers/:id', authenticate, requireRole('Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deletePublisher(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Publisher deleted' });
    } catch (err) { next(err); }
  },
);

router.get('/publishers/:id/usage', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usage = await catalogService.getPublisherUsage(parseInt(req.params['id'] as string, 10));
      res.json(usage);
    } catch (err) { next(err); }
  },
);

router.post('/publishers/:id/archive', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.archivePublisher(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Publisher archived' });
    } catch (err) { next(err); }
  },
);

router.post('/publishers/:id/restore', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.restorePublisher(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Publisher restored' });
    } catch (err) { next(err); }
  },
);

router.post('/publishers/:id/deactivate', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deactivatePublisher(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Publisher set inactive' });
    } catch (err) { next(err); }
  },
);

router.post('/publishers/:id/activate', authenticate, requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.activatePublisher(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Publisher activated' });
    } catch (err) { next(err); }
  },
);

// ── GET /api/book-formats ─────────────────────────────────────────────────────

router.get('/book-formats', authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await catalogService.listBookFormats();
    res.json({ items });
  } catch (err) { next(err); }
});

// ── GET /api/book-editions ────────────────────────────────────────────────────

router.get('/book-editions', authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await catalogService.listBookEditions();
    res.json({ items });
  } catch (err) { next(err); }
});

// ── Internal helper (prices list) ─────────────────────────────────────────────

async function db_query_prices(bookId: number) {
  const result = await db.query(
    `SELECT bbp.branch_id, b2.name AS branch_name, bbp.price
     FROM book_branch_prices bbp
     JOIN branches b2 ON b2.id = bbp.branch_id
     WHERE bbp.book_id = $1
     ORDER BY b2.name ASC`,
    [bookId],
  );
  return {
    items: result.rows.map(r => ({
      branchId: r.branch_id as number,
      branchName: r.branch_name as string,
      price: parseFloat(r.price as string),
    })),
  };
}

export default router;
