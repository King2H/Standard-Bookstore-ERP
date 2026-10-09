import type { LifecycleStatus, Money } from '@bms/shared';

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
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
  edition: string | null;
  language: string | null;
  format: string | null;
  description: string | null;
  coverImageUrl: string | null;
  defaultPrice: Money | null;
  tradeValue: Money | null;
  isActive: boolean;
  status: LifecycleStatus;
  archivedAt: Date | null;
  createdAt: Date;
  categories: string[];
  categoryIds: number[];
  tags: string[];
  /** The price in the branch the query asked about, when it has its own. */
  branchPrice: Money | null;
}

export interface BookFilter {
  /** Partial match on title, author, SKU, publisher, description; exact on any of `qIsbns`. */
  q?: string;
  /** The ISBNs `q` may be (an ISBN-10 carries its ISBN-13 too). */
  qIsbns?: string[];
  /** Exact ISBN filter, in any of these forms. */
  isbns?: string[];
  sku?: string;
  author?: string;
  genre?: string;
  category?: string;
  tag?: string;
  /** Undefined means both. Ignored when `statuses` is set. */
  isActive?: boolean;
  statuses?: LifecycleStatus[];
  sortBy?: 'title' | 'isbn' | 'created_at' | 'default_price';
  sortDir?: 'asc' | 'desc';
}

/** The book columns a create or update writes; undefined leaves a column as it is. */
export interface BookFields {
  isbn?: string;
  sku?: string | null;
  title?: string;
  genre?: string | null;
  publisher?: string | null;
  publisherId?: number | null;
  formatId?: number | null;
  editionId?: number | null;
  edition?: string | null;
  language?: string | null;
  format?: string | null;
  description?: string | null;
  coverImageUrl?: string | null;
  defaultPrice?: number | null;
  tradeValue?: number | null;
}

/** A field change kept in book_edit_history. */
export interface BookEdit {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface BookEditRecord {
  id: string;
  bookId: number;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: number;
  changedByUsername: string | null;
  changedAt: Date;
}

export interface BranchPriceRecord {
  branchId: number;
  branchName: string;
  price: Money;
}

/** An author or category a book links to, found by name. */
export interface LinkedName {
  id: number;
  name: string;
  status: LifecycleStatus;
}

export type Paging = { page: number; pageSize: number };
