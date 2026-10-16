import type { Category } from '@bms/shared';

/**
 * Whether `candidate` may be offered as the parent of the category being
 * edited: not the category itself, nor one directly under it. The API
 * refuses those, and any deeper subcategory too (checkCategoryParent).
 */
export function isParentChoice(candidate: Pick<Category, 'id' | 'parentId'>, editingId: number | null): boolean {
  if (editingId === null) return true;
  return candidate.id !== editingId && candidate.parentId !== editingId;
}
