import { useState } from 'react';
import type { Branch, SetStaffRolesRequest } from '@bms/shared';
import { inBranches } from '../rules.js';

type Assignment = SetStaffRolesRequest[number];
/** A role as the staff list gives it. */
type Held = { branchId: number; branchName: string | null; role: string };

const selectCls = 'flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-blue-500 transition-colors';

/**
 * Edits a staff member's roles. Roles the signed-in staff member may not
 * change (a role at or above their own, or in a branch they do not manage)
 * are shown and sent back as they are, as the API requires.
 */
export function RoleEditor({ currentRoles, branches, grantable, reach, onSave, onCancel }: {
  currentRoles: Held[];
  /** The open branches. */
  branches: Branch[];
  /** The roles the signed-in staff member may grant. */
  grantable: string[];
  /** The branches whose roles they may change. */
  reach: 'all' | number[];
  onSave: (roles: SetStaffRolesRequest) => void;
  onCancel: () => void;
}) {
  const editable = (r: Held) => grantable.includes(r.role) && inBranches(reach, r.branchId);
  const choices = branches.filter(b => inBranches(reach, b.id));
  const nameOf = (r: Held) => r.branchName ?? branches.find(b => b.id === r.branchId)?.name ?? `Branch ${r.branchId}`;
  const kept = currentRoles.filter(r => !editable(r));
  const firstRole = grantable.includes('Sales') ? 'Sales' : grantable[0] ?? 'Sales';
  const [assignments, setAssignments] = useState<Held[]>(() => {
    const mine = currentRoles.filter(editable);
    return mine.length > 0 || kept.length > 0 ? mine : [{ branchId: choices[0]?.id ?? 0, branchName: null, role: firstRole }];
  });

  const update = (index: number, change: Partial<Held>) => {
    setAssignments(prev => prev.map((a, i) => (i === index ? { ...a, ...change } : a)));
  };
  // Roles come from the contract's list: the API's own, or the grantable ones offered here.
  const strip = (r: Held): Assignment => ({ branchId: r.branchId, role: r.role as Assignment['role'] });

  return (
    <div className="space-y-2 py-1">
      {kept.map((a, i) => (
        <div key={`kept-${i}`} className="text-xs text-gray-500 dark:text-gray-400" title="Not yours to change">
          {nameOf(a)} · {a.role}
        </div>
      ))}
      {assignments.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <select aria-label="Branch" value={a.branchId} onChange={e => update(i, { branchId: Number(e.target.value), branchName: null })} className={selectCls}>
            {/* A role in a closed branch keeps its own branch's name. */}
            {!choices.some(b => b.id === a.branchId) && <option value={a.branchId}>{nameOf(a)}</option>}
            {choices.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select aria-label="Role" value={a.role} onChange={e => update(i, { role: e.target.value })} className={selectCls}>
            {grantable.map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          {assignments.length + kept.length > 1 && (
            <button type="button" onClick={() => setAssignments(prev => prev.filter((_, j) => j !== i))}
              className="text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 text-xs font-bold px-1 transition-colors" title="Remove">✕</button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button type="button"
          onClick={() => {
            const firstBranch = choices[0];
            if (firstBranch) setAssignments(prev => [...prev, { branchId: firstBranch.id, branchName: null, role: firstRole }]);
          }}
          disabled={choices.length === 0}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-40 transition-colors">
          + Add Role
        </button>
        <button type="button" onClick={() => onSave([...kept, ...assignments].map(strip))}
          className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-lg transition-colors">
          Save
        </button>
        <button type="button" onClick={onCancel}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
