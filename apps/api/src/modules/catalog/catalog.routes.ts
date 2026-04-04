import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../../db/index.js';
import * as catalogService from './catalog.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

// Helper: safely extract a single string from req.query (handles string | string[] | ParsedQs)
const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const qi = (v: unknown, fallback: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fallback : fallback; };

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
        q:        qs(req.query.q),
        isbn:     qs(req.query.isbn),
        genre:    qs(req.query.genre),
        category: qs(req.query.category),
        tag:      qs(req.query.tag),
        isActive: req.query.is_active !== undefined
          ? req.query.is_active === 'true'
          : undefined,
        branchId: req.query.branchId ? qi(req.query.branchId, 0) : undefined,
        sortBy:   qs(req.query.sortBy) as catalogService.SearchFilters['sortBy'],
        sortDir:  qs(req.query.sortDir) as 'asc' | 'desc' | undefined,
        page:     qi(req.query.page, 1),
        pageSize: qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/books ───────────────────────────────────────────────────────────

router.post(
  '/books',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
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

// ── GET /api/books/:id ────────────────────────────────────────────────────────

router.get(
  '/books/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id as string, 10);
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
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id as string, 10);
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
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id as string, 10);
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
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      await catalogService.reactivateBook(id, req.staff!);
      res.json({ message: 'Book reactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/books/:id/history ────────────────────────────────────────────────

router.get(
  '/books/:id/history',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id as string, 10);
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
      const id = parseInt(req.params.id as string, 10);
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
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bookId = parseInt(req.params.id as string, 10);
      const branchId = parseInt(req.params.branchId as string, 10);
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
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/authors', authenticate, requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const author = await catalogService.createAuthor(parsed.data.name, req.staff!);
      res.status(201).json(author);
    } catch (err) { next(err); }
  },
);

router.put('/authors/:id', authenticate, requireRole('Super_Admin', 'Admin', 'Manager'),
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

router.delete('/authors/:id', authenticate, requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deleteAuthor(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Author deleted' });
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
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/categories', authenticate, requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = categoryWriteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const cat = await catalogService.createCategory(parsed.data, req.staff!);
      res.status(201).json(cat);
    } catch (err) { next(err); }
  },
);

router.put('/categories/:id', authenticate, requireRole('Super_Admin', 'Admin', 'Manager'),
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

router.delete('/categories/:id', authenticate, requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deleteCategory(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Category deleted' });
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
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/publishers', authenticate, requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const pub = await catalogService.createPublisher(parsed.data.name, req.staff!);
      res.status(201).json(pub);
    } catch (err) { next(err); }
  },
);

router.put('/publishers/:id', authenticate, requireRole('Super_Admin', 'Admin', 'Manager'),
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

router.delete('/publishers/:id', authenticate, requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await catalogService.deletePublisher(parseInt(req.params['id'] as string, 10), req.staff!);
      res.json({ message: 'Publisher deleted' });
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
