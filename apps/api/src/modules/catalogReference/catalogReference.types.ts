import type { LifecycleStatus } from '@bms/shared';

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

/** The reference data books link to. */
export type ReferenceKind = 'author' | 'category' | 'publisher';

export type LifecycleAction = 'ACTIVATE' | 'INACTIVATE' | 'ARCHIVE' | 'RESTORE';

export interface AuthorRecord {
  id: number;
  name: string;
  normalizedName: string;
  status: LifecycleStatus;
  archivedAt: Date | null;
  createdAt: Date;
  bookCount?: number;
}

export interface CategoryRecord {
  id: number;
  name: string;
  normalizedName: string;
  parentId: number | null;
  parentName?: string | null;
  status: LifecycleStatus;
  archivedAt: Date | null;
  createdAt: Date;
  bookCount?: number;
}

export interface PublisherRecord {
  id: number;
  name: string;
  status: LifecycleStatus;
  archivedAt: Date | null;
  createdAt: Date;
  bookCount?: number;
}

/** A book format or edition. */
export interface LookupRecord {
  id: number;
  code: string;
  label: string;
  sortOrder: number;
}

export interface ReferenceFilter {
  /** Start of the name, any letter case. */
  q?: string;
  /** Undefined means any status. */
  statuses?: LifecycleStatus[];
}

export type Paging = { page: number; pageSize: number };
