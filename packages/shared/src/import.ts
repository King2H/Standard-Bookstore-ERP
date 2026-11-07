import { z } from 'zod';

// Bulk import and export (#246, owner decisions 1a–4a, 2026-11-07): lists the
// shop starts with, as CSV files (3a). A file is checked before anything is
// saved; it is saved when clean, or only its valid rows when the user asks.

/** The largest file taken: 5,000 titles take about 1 MB. */
export const IMPORT_MAX_CHARS = 10_000_000;

/** The columns of the catalog file, in the template's and the export's order. */
export const CATALOG_IMPORT_COLUMNS = ['ISBN', 'SKU', 'Title', 'Authors', 'Publisher', 'Categories', 'Format', 'Language', 'Price'] as const;

export const ImportKindSchema = z.enum(['catalog']);
export type ImportKind = z.infer<typeof ImportKindSchema>;

export const ImportRequestSchema = z.object({
  /** The file's text, as read from the CSV. */
  csv: z.string().min(1).max(IMPORT_MAX_CHARS),
  /** The file's name, recorded in the audit log. */
  fileName: z.string().trim().max(255).optional(),
  /** Save the valid rows and leave the others; otherwise a file with an invalid row saves nothing. */
  onlyValid: z.boolean().default(false),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ImportRowErrorSchema = z.object({
  /** The line in the file, the header being line 1. */
  line: z.number().int(),
  messages: z.array(z.string()),
});
export type ImportRowError = z.infer<typeof ImportRowErrorSchema>;

/** What a file would do, checked before anything is saved. */
export const ImportReportSchema = z.object({
  kind: ImportKindSchema,
  /** Data rows in the file (empty lines left out). */
  rows: z.number().int(),
  valid: z.number().int(),
  toCreate: z.number().int(),
  toUpdate: z.number().int(),
  unchanged: z.number().int(),
  /** The invalid rows, at most 500; `moreErrors` counts the rest. */
  errors: z.array(ImportRowErrorSchema),
  moreErrors: z.number().int(),
  /** Names the import would add to the reference lists. */
  newNames: z.object({ authors: z.array(z.string()), categories: z.array(z.string()), publishers: z.array(z.string()) }),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

export const ImportResultSchema = ImportReportSchema.extend({
  created: z.number().int(),
  updated: z.number().int(),
  /** Invalid rows left out (onlyValid). */
  skipped: z.number().int(),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;
