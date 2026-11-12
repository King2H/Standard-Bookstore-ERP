import type { ProfileResponse } from '@bms/shared';
import { BranchPicker } from '../../branches/components/BranchPicker.js';

/** The branches a limited reach covers, named from the signed-in account's own roles. */
export function managedBranches(me: Pick<ProfileResponse, 'roles'> | undefined, reach: 'all' | number[]): Array<{ id: number; name: string }> {
  if (reach === 'all' || !me) return [];
  const named = new Map(me.roles.map((r) => [r.branchId, r.branchName]));
  return reach.map((id) => ({ id, name: named.get(id) ?? `Branch ${id}` }));
}

/**
 * The branch of a role being granted (#266). With every branch in reach, any
 * open branch is found by typing (was: a dropdown of the first 100); else the
 * few branches the signed-in staff member manages are listed. 0 is none yet.
 */
export function BranchChoice({ reach, managed, value, onChange, currentName, className }: {
  reach: 'all' | number[];
  managed: Array<{ id: number; name: string }>;
  value: number;
  onChange: (branchId: number) => void;
  /** The name of the branch held now, should it be one no longer offered (a closed branch). */
  currentName?: string;
  className: string;
}) {
  if (reach === 'all') {
    return (
      <div className="flex-1">
        <BranchPicker aria-label="Branch" value={value > 0 ? value : null} onChange={(id) => onChange(id ?? 0)} placeholder="Type a branch…" className={className} />
      </div>
    );
  }
  return (
    <select aria-label="Branch" value={value} onChange={(e) => onChange(Number(e.target.value))} className={className}>
      <option value={0}>Select branch...</option>
      {value > 0 && !managed.some((b) => b.id === value) && <option value={value}>{currentName ?? `Branch ${value}`}</option>}
      {managed.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
}
