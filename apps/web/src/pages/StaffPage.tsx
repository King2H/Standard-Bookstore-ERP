import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

interface StaffRole { branchId: number; role: string }
interface StaffMember {
  id: number;
  username: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  roles: StaffRole[];
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
        username: body.username,
        password: body.password,
        fullName: body.fullName,
      });
      await api.put(`/staff/${staffId}/roles`, body.assignments);
      return staffId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      setShowForm(false);
      reset();
      setApiError(null);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      showToast('Staff deactivated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Cannot deactivate this staff member', 'error');
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: number) => api.post(`/staff/${id}/reactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      showToast('Staff reactivated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to reactivate staff', 'error');
    },
  });

  const assignRolesMutation = useMutation({
    mutationFn: ({ id, roles }: { id: number; roles: StaffRole[] }) =>
      api.put(`/staff/${id}/roles`, roles),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff'] });
      setEditingRoles(null);
      showToast('Branch & role assignments updated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to update assignments', 'error');
    },
  });

  const { register, handleSubmit, reset, control, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      username: '', password: '', fullName: '',
      assignments: [{ branchId: branches[0]?.id ?? 0, role: 'Sales' }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'assignments' });

  // Get already-selected branch IDs to prevent duplicates
  const getUsedBranchIds = (currentIndex: number, allAssignments: { branchId: number }[]) =>
    allAssignments.map((a, i) => i !== currentIndex ? a.branchId : null).filter(Boolean);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Staff</h1>
        <button type="button" onClick={() => { setShowForm(!showForm); setApiError(null); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700">
          {showForm ? 'Cancel' : '+ New Staff'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit((data) => { setApiError(null); createMutation.mutate(data); })}
          className="bg-white border border-gray-200 rounded-lg p-4 mb-6 space-y-4">
          <h2 className="font-medium text-gray-800">Create Staff Account</h2>
          {apiError && <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">{apiError}</div>}

          {/* Basic info */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Username <span className="text-red-500">*</span></label>
              <input {...register('username')} placeholder="e.g. john.doe" className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              {errors.username && <p className="text-red-500 text-xs mt-1">{errors.username.message}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Full Name <span className="text-red-500">*</span></label>
              <input {...register('fullName')} placeholder="e.g. John Doe" className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              {errors.fullName && <p className="text-red-500 text-xs mt-1">{errors.fullName.message}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Password <span className="text-red-500">*</span></label>
              <input {...register('password')} type="password" placeholder="Min 10 chars" className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
              {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
            </div>
          </div>

          {/* Branch-Role assignments */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600">
                Branch & Role Assignments <span className="text-red-500">*</span>
                <span className="text-gray-400 font-normal ml-1">(one role per branch)</span>
              </label>
              <button type="button"
                onClick={() => {
                  const usedIds = fields.map(f => (f as unknown as { branchId: number }).branchId);
                  const nextBranch = branches.find(b => !usedIds.includes(b.id));
                  if (nextBranch) append({ branchId: nextBranch.id, role: 'Sales' });
                }}
                disabled={fields.length >= branches.length}
                className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40 disabled:cursor-not-allowed">
                + Add Branch Assignment
              </button>
            </div>
            {errors.assignments?.root && <p className="text-red-500 text-xs mb-2">{errors.assignments.root.message}</p>}
            <div className="space-y-2">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <select {...register(`assignments.${index}.branchId`)}
                    className="flex-1 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500">
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
                  <select {...register(`assignments.${index}.role`)}
                    className="flex-1 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500">
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {fields.length > 1 && (
                    <button type="button" onClick={() => remove(index)} className="text-red-500 hover:text-red-700 text-xs px-1">✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending || isSubmitting}
              className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {createMutation.isPending ? 'Creating...' : 'Create Staff'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); reset(); setApiError(null); }}
              className="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm font-medium hover:bg-gray-200">
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading staff...</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Username</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Full Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Branch</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {staffData?.items.map((staff) => (
                <tr key={staff.id} className={`hover:bg-gray-50 ${editingRoles === staff.id ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3 font-medium text-gray-900">{staff.username}</td>
                  <td className="px-4 py-3 text-gray-600">{staff.fullName}</td>

                  {/* Branch column */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {staff.roles.map((r, i) => {
                        const branch = branches.find(b => b.id === r.branchId);
                        return (
                          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                            {branch?.name ?? `Branch ${r.branchId}`}
                          </span>
                        );
                      })}
                    </div>
                  </td>

                  {/* Role column */}
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
                          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                            {r.role}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* Status column */}
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${staff.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                      {staff.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>

                  {/* Actions column — icon buttons */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {/* Edit branch/role assignments */}
                      {editingRoles !== staff.id && (
                        <button
                          type="button"
                          title="Edit branch & role assignments"
                          onClick={() => setEditingRoles(staff.id)}
                          className="text-gray-400 hover:text-blue-600 transition-colors"
                        >
                          {/* Pencil icon */}
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                          </svg>
                        </button>
                      )}

                      {/* Deactivate / Reactivate */}
                      {staff.isActive ? (
                        <button
                          type="button"
                          title="Deactivate staff"
                          onClick={() => deactivateMutation.mutate(staff.id)}
                          disabled={deactivateMutation.isPending}
                          className="text-gray-400 hover:text-red-600 transition-colors disabled:opacity-40"
                        >
                          {/* Ban / pause icon */}
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="Reactivate staff"
                          onClick={() => reactivateMutation.mutate(staff.id)}
                          disabled={reactivateMutation.isPending}
                          className="text-gray-400 hover:text-green-600 transition-colors disabled:opacity-40"
                        >
                          {/* Check-circle icon */}
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
            <p className="text-center text-gray-500 text-sm py-8">No staff found</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Inline role editor component ──────────────────────────────────────────────

function RoleEditor({
  currentRoles, branches, onSave, onCancel,
}: {
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

  return (
    <div className="space-y-2 py-1">
      {assignments.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <select
            value={a.branchId}
            onChange={e => update(i, 'branchId', parseInt(e.target.value, 10))}
            className="flex-1 border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {branches.map(b => (
              <option key={b.id} value={b.id} disabled={usedBranchIds(i).includes(b.id)}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            value={a.role}
            onChange={e => update(i, 'role', e.target.value)}
            className="flex-1 border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          {assignments.length > 1 && (
            <button
              type="button"
              onClick={() => setAssignments(prev => prev.filter((_, j) => j !== i))}
              className="text-red-400 hover:text-red-600 text-xs font-bold px-1"
              title="Remove"
            >✕</button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => {
            const used = assignments.map(a => a.branchId);
            const next = branches.find(b => !used.includes(b.id));
            if (next) setAssignments(prev => [...prev, { branchId: next.id, role: 'Sales' }]);
          }}
          disabled={assignments.length >= branches.length}
          className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40"
        >
          + Add Branch
        </button>
        <button
          type="button"
          onClick={() => onSave(assignments)}
          className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

