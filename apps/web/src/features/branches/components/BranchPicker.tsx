import { SearchPicker } from '../../../shared/components/SearchPicker.js';
import { PICKER_PAGE_SIZE } from '../../../shared/picker.js';
import { listBranches } from '../api.js';
import { useBranch } from '../queries.js';

/**
 * Choose an open branch by typing part of its name (#266): every branch can
 * be found, however many there are (was: a dropdown of the first 100).
 * `exclude` leaves branches out, e.g. the one a transfer leaves from. An
 * emptied box is no branch (null), which a filter reads as "all".
 */
export function BranchPicker({
  value, onChange, exclude = [], placeholder = 'Type a branch…', className = '', 'aria-label': ariaLabel, id, invalid,
}: {
  value: number | null;
  onChange: (branchId: number | null) => void;
  exclude?: number[];
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  id?: string;
  invalid?: boolean;
}) {
  const { data: branch } = useBranch(value);
  const option = value === null ? null : { id: value, label: branch?.name ?? '' };
  return (
    <SearchPicker
      id={id}
      aria-label={ariaLabel}
      value={option}
      onChange={(o) => onChange(o ? o.id : null)}
      queryKey={`branches:open:${exclude.join(',')}`}
      search={async (q, page) => {
        const found = await listBranches({ isActive: 'true', q: q || undefined, page, pageSize: PICKER_PAGE_SIZE });
        const items = found.items.filter((b) => !exclude.includes(b.id));
        return { items: items.map((b) => ({ id: b.id, label: b.name })), total: found.total - (found.items.length - items.length) };
      }}
      placeholder={placeholder}
      invalid={invalid}
      className={className}
    />
  );
}
