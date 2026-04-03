import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

interface StaffRole { branchId: number; branchName?: string; role: string }
interface StaffMember {
  id: number;
  username: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  roles: StaffRole[];
  failedLoginAttempts?: number;
  lockedUntil?: string | null;
  mustChangePassword?: boolean;
  lastLoginAt?: string | null;
}
interface Branch { id: number; name: string; isActive: boolean }

const ROLES = ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] as const;

const createSchema = z.object({
  username: z.string().min(3, 'Min 3 characters').max(50),
  password: z.string().min(10, 'Min 10 characters'),
  fullName: z.string().min(1, 'Full name is required'),
  assignments: z.array(z.object({
    branchId: z.coerce.number().int().positive('Select a branch'),
    role: z.enum(ROLES, { errorMap: () => ({ message: 'Select a role' }) }),
  })).min(1, 'At least one branch-role assignment is required'),
});
type CreateForm = z.infer<typeof createSchema>;

const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors';

export default function StaffPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [editingRoles, setEditingRoles] = useState<number | null>(null);
  const { showToast } = useToast();

  const { data: staffData, isLoading } = useQuery({
    queryKey: ['staff'],
    queryFn: () => api.get<{ items: StaffMember[]; total: number }>('/staff'),
    enabled: !!getAccessToken(),
    retry: false,
  });

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<{ items: Branch[] }>('/branches'),
    enabled: !!getAccessToken(),
    retry: false,
  });

  const branches = branchData?.items.filter(b => b.isActive) ?? [];

  const createMutation = useMutation({
    mutationFn: async (body: CreateForm) => {
      const { staffId } = await api.post<{ staffId: number }>('/staff', {
        username: body.username, password: body.password, fullName: body.fullName,
      });
      await api.put(`/staff/${staffId}/roles`, body.assignments);
      return staffId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      setShowForm(false); reset(); setApiError(null);
      showToast('Staff account created successfully');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      setApiError(e.message ?? 'Failed to create staff');
      showToast(e.message ?? 'Failed to create staff', 'error');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => api.post(`/staff/${id}/deactivate`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['staff'] }); showToast('Staff deactivated'); },
    onError: (err: unknown) => { const e = err as { message?: string }; showToast(e.message ?? 'Cannot deactivate this staff member', 'error'); },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: number) => api.post(`/staff/${id}/reactivate`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['staff'] }); showToast('Staff reactivated'); },
    onError: (err: unknown) => { const e = err as { message?: string }; showToast(e.message ?? 'Failed to reactivate staff', 'error'); },
  });

  const assignRolesMutation = useMutation({
    mutationFn: ({ id, roles }: { id: number; roles: StaffRole[] }) => api.put(`/staff/${id}/roles`, roles),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      setEditingRoles(null);
      showToast('Branch & role assignments updated');
    },
    onError: (err: unknown) => { const e = err as { message?: string }; showToast(e.message ?? 'Failed to update assignments', 'error'); },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, temporaryPassword }: { id: number; temporaryPassword: string }) =>
      api.post(`/staff/${id}/reset-password`, { temporaryPassword }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      showToast('Password reset. Staff must change password on next login.');
    },
    onError: (err: unknown) => { const e = err as { message?: string }; showToast(e.message ?? 'Failed to reset password', 'error'); },
  });

  const unlockMutation = useMutation({
    mutationFn: (id: number) => api.post(`/staff/${id}/unlock`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      showToast('Account unlocked');
    },
    onError: (err: unknown) => { const e = err as { message?: string }; showToast(e.message ?? 'Failed to unlock account', 'error'); },
  });

  const { register, handleSubmit, reset, control, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { username: '', password: '', fullName: '', assignments: [{ branchId: branches[0]?.id ?? 0, role: 'Sales' }] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'assignments' });

  const getUsedBranchIds = (currentIndex: number, allAssignments: { branchId: number }[]) =>
    allAssignments.map((a, i) => i !== currentIndex ? a.branchId : null).filter(Boolean);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Staff</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Manage staff accounts and branch assignments</p>
        </div>
        <button type="button" onClick={() => { setShowForm(!showForm); setApiError(null); }}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm">
          {showForm ? 'Cancel' : '+ New Staff'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit((data) => { setApiError(null); createMutation.mutate(data); })}
          className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-6 space-y-4 shadow-sm">
          <h2 className="font-semibold text-gray-800 dark:text-gray-100">Create Staff Account</h2>
          {apiError && (
            <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-sm text-red-700 dark:text-red-400">
              {apiError}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Username <span className="text-red-500">*</span></label>
              <input {...register('username')} placeholder="e.g. john.doe" className={inputCls} />
              {errors.username && <p className="text-red-500 text-xs mt-1">{errors.username.message}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Full Name <span className="text-red-500">*</span></label>
              <input {...register('fullName')} placeholder="e.g. John Doe" className={inputCls} />
              {errors.fullName && <p className="text-red-500 text-xs mt-1">{errors.fullName.message}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Password <span className="text-red-500">*</span></label>
              <input {...register('password')} type="password" placeholder="Min 10 chars" className={inputCls} />
              {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Branch & Role Assignments <span className="text-red-500">*</span>
                <span className="text-gray-400 dark:text-gray-500 font-normal ml-1">(one role per branch)</span>
              </label>
              <button type="button"
                onClick={() => {
                  const usedIds = fields.map(f => (f as unknown as { branchId: number }).branchId);
                  const nextBranch = branches.find(b => !usedIds.includes(b.id));
                  if (nextBranch) append({ branchId: nextBranch.id, role: 'Sales' });
                }}
                disabled={fields.length >= branches.length}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                + Add Branch Assignment
              </button>
            </div>
            {errors.assignments?.root && <p className="text-red-500 text-xs mb-2">{errors.assignments.root.message}</p>}
            <div className="space-y-2">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <select {...register(`assignments.${index}.branchId`)} className={inputCls}>
                    <option value="">Select branch...</option>
                    {branches.map(b => {
                      const usedIds = getUsedBranchIds(index, fields as { branchId: number }[]);
                      return (
                        <option key={b.id} value={b.id} disabled={usedIds.includes(b.id)}>
                          {b.name}{usedIds.includes(b.id) ? ' (already assigned)' : ''}
                        </option>
                      );
                    })}
                  </select>
                  <select {...register(`assignments.${index}.role`)} className={inputCls}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {fields.length > 1 && (
                    <button type="button" onClick={() => remove(index)}
                      className="text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 text-xs px-1 transition-colors">✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending || isSubmitting}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
              {createMutation.isPending ? 'Creating...' : 'Create Staff'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); reset(); setApiError(null); }}
              className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm py-8">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading staff...
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Username</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Full Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Branch</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {staffData?.items.map((staff) => (
                <tr key={staff.id} className={`transition-colors ${editingRoles === staff.id ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{staff.username}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{staff.fullName}</td>

                  {/* Branch column */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {staff.roles.map((r, i) => {
                        const displayName = r.branchName ?? `Branch ${r.branchId}`;
                        return (
                          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                            {displayName}
                          </span>
                        );
                      })}
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    {editingRoles === staff.id ? (
                      <RoleEditor
                        currentRoles={staff.roles}
                        branches={branches}
                        onSave={(roles) => assignRolesMutation.mutate({ id: staff.id, roles })}
                        onCancel={() => setEditingRoles(null)}
                      />
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {staff.roles.map((r, i) => (
                          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                            {r.role}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        staff.isActive
                          ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                      }`}>
                        {staff.isActive ? 'Active' : 'Inactive'}
                      </span>
                      {staff.lockedUntil && new Date(staff.lockedUntil) > new Date() && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400">
                          🔒 Locked
                        </span>
                      )}
                      {staff.mustChangePassword && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400">
                          ⚠ Must reset
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {editingRoles !== staff.id && (
                        <button type="button" title="Edit branch & role assignments"
                          onClick={() => setEditingRoles(staff.id)}
                          className="text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                          </svg>
                        </button>
                      )}
                      {/* Unlock button — shown when account is locked */}
                      {staff.lockedUntil && new Date(staff.lockedUntil) > new Date() && (
                        <button type="button" title="Unlock account"
                          onClick={() => unlockMutation.mutate(staff.id)}
                          disabled={unlockMutation.isPending}
                          className="text-gray-400 dark:text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 transition-colors disabled:opacity-40">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                          </svg>
                        </button>
                      )}
                      {/* Reset password button */}
                      <button type="button" title="Reset password (staff must change on next login)"
                        onClick={() => {
                          const tmp = prompt(`Set temporary password for ${staff.username} (min 10 chars, upper+lower+digit+special):`);
                          if (tmp) resetPasswordMutation.mutate({ id: staff.id, temporaryPassword: tmp });
                        }}
                        disabled={resetPasswordMutation.isPending}
                        className="text-gray-400 dark:text-gray-500 hover:text-orange-600 dark:hover:text-orange-400 transition-colors disabled:opacity-40">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                        </svg>
                      </button>
                      {staff.isActive ? (
                        <button type="button" title="Deactivate staff"
                          onClick={() => deactivateMutation.mutate(staff.id)}
                          disabled={deactivateMutation.isPending}
                          className="text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-40">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                        </button>
                      ) : (
                        <button type="button" title="Reactivate staff"
                          onClick={() => reactivateMutation.mutate(staff.id)}
                          disabled={reactivateMutation.isPending}
                          className="text-gray-400 dark:text-gray-500 hover:text-green-600 dark:hover:text-green-400 transition-colors disabled:opacity-40">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(!staffData?.items || staffData.items.length === 0) && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No staff found</p>
          )}
        </div>
      )}
    </div>
  );
}

function RoleEditor({ currentRoles, branches, onSave, onCancel }: {
  currentRoles: StaffRole[];
  branches: Branch[];
  onSave: (roles: StaffRole[]) => void;
  onCancel: () => void;
}) {
  const [assignments, setAssignments] = useState<StaffRole[]>(
    currentRoles.length > 0
      ? currentRoles.map(r => ({ branchId: Number(r.branchId), role: r.role }))
      : [{ branchId: branches[0]?.id ?? 0, role: 'Sales' }]
  );

  const update = (index: number, field: keyof StaffRole, value: string | number) => {
    setAssignments(prev => prev.map((a, i) =>
      i === index ? { ...a, [field]: field === 'branchId' ? Number(value) : value } : a
    ));
  };

  const usedBranchIds = (currentIndex: number) =>
    assignments.map((a, i) => i !== currentIndex ? a.branchId : null).filter(Boolean) as number[];

  const selectCls = 'flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors';

  return (
    <div className="space-y-2 py-1">
      {assignments.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={a.branchId} onChange={e => update(i, 'branchId', parseInt(e.target.value, 10))} className={selectCls}>
            {branches.map(b => (
              <option key={b.id} value={b.id} disabled={usedBranchIds(i).includes(b.id)}>{b.name}</option>
            ))}
          </select>
          <select value={a.role} onChange={e => update(i, 'role', e.target.value)} className={selectCls}>
            {(['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] as const).map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          {assignments.length > 1 && (
            <button type="button" onClick={() => setAssignments(prev => prev.filter((_, j) => j !== i))}
              className="text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 text-xs font-bold px-1 transition-colors" title="Remove">✕</button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button type="button"
          onClick={() => {
            const used = assignments.map(a => a.branchId);
            const next = branches.find(b => !used.includes(b.id));
            if (next) setAssignments(prev => [...prev, { branchId: next.id, role: 'Sales' }]);
          }}
          disabled={assignments.length >= branches.length}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-40 transition-colors">
          + Add Branch
        </button>
        <button type="button" onClick={() => onSave(assignments)}
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
