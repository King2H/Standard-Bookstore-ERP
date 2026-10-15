import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PasswordSchema, RoleSchema, UsernameSchema, type Branch, type CreateStaffRequest } from '@bms/shared';
import { inputCls } from './styles.js';

/** The form's fields, checked with the rules of the API's create-staff contract. */
export const StaffFormSchema = z.object({
  username: z.string().trim().min(3, 'Min 3 characters').pipe(UsernameSchema),
  password: PasswordSchema,
  fullName: z.string().trim().min(1, 'Full name is required').max(100, 'At most 100 characters'),
  isAllBranches: z.boolean(),
  allBranchesRole: RoleSchema,
  // branchId 0 is the "Select branch..." placeholder.
  assignments: z.array(z.object({ branchId: z.coerce.number<string | number>().int().min(0), role: RoleSchema })),
}).refine(data => data.isAllBranches || data.assignments.some(a => a.branchId > 0), {
  message: 'At least one branch-role assignment is required (or enable All Branches)',
  path: ['assignments'],
});
type FormInput = z.input<typeof StaffFormSchema>;
type FormValues = z.output<typeof StaffFormSchema>;

/** The request the form's values make. With access to all branches the role goes on the first open branch. */
export function createRequestOf(v: FormValues, allowAllBranches: boolean, branches: Branch[]): CreateStaffRequest {
  const allBranches = allowAllBranches && v.isAllBranches;
  const roles = allBranches
    ? (branches.length > 0 ? [{ branchId: branches[0].id, role: v.allBranchesRole }] : [])
    : v.assignments.filter(a => a.branchId > 0);
  return { username: v.username, password: v.password, fullName: v.fullName, roles, isAllBranches: allBranches };
}

export function StaffForm({ branches, grantable, allowAllBranches, busy, error, onSubmit, onCancel }: {
  /** The open branches to pick from. */
  branches: Branch[];
  grantable: string[];
  /** Super_Admin only. */
  allowAllBranches: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (body: CreateStaffRequest) => void;
  onCancel: () => void;
}) {
  const { register, handleSubmit, control, watch, formState: { errors, isSubmitting } } = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(StaffFormSchema),
    defaultValues: { username: '', password: '', fullName: '', isAllBranches: false, allBranchesRole: 'Sales', assignments: [{ branchId: 0, role: 'Sales' }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'assignments' });
  const watchIsAllBranches = watch('isAllBranches');

  return (
    <form onSubmit={handleSubmit((v) => onSubmit(createRequestOf(v, allowAllBranches, branches)))}
      className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-6 space-y-4 shadow-xs">
      <h2 className="font-semibold text-gray-800 dark:text-gray-100">Create Staff Account</h2>
      {error && (
        <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label htmlFor="staff-username" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Username <span className="text-red-500">*</span></label>
          <input id="staff-username" {...register('username')} placeholder="e.g. john.doe" className={inputCls} />
          {errors.username && <p className="text-red-500 text-xs mt-1">{errors.username.message}</p>}
        </div>
        <div>
          <label htmlFor="staff-full-name" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Full Name <span className="text-red-500">*</span></label>
          <input id="staff-full-name" {...register('fullName')} placeholder="e.g. John Doe" className={inputCls} />
          {errors.fullName && <p className="text-red-500 text-xs mt-1">{errors.fullName.message}</p>}
        </div>
        <div>
          <label htmlFor="staff-password" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Password <span className="text-red-500">*</span></label>
          <input id="staff-password" {...register('password')} type="password" placeholder="Min 10 chars" className={inputCls} />
          {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
        </div>
      </div>

      <div>
        {allowAllBranches && <div className="flex items-center gap-3 mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
            <input type="checkbox" {...register('isAllBranches')} className="w-4 h-4 rounded-sm border-gray-300 text-amber-600 focus:ring-amber-500" />
            <span className="text-xs font-semibold text-amber-800 dark:text-amber-300 whitespace-nowrap">🌐 All Branches</span>
          </label>
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {watchIsAllBranches
              ? 'Staff can access every branch. Select a role below — no per-branch assignment needed.'
              : 'Enable to grant access to all current and future branches without per-branch assignment.'}
          </span>
        </div>}

        {allowAllBranches && watchIsAllBranches ? (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
              Role <span className="text-red-500">*</span>
              <span className="text-gray-400 dark:text-gray-500 font-normal ml-1">(applies to all branches)</span>
            </label>
            <div className="flex items-center gap-2">
              <select {...register('allBranchesRole')} className={inputCls} style={{ maxWidth: 240 }}>
                {grantable.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Branch & Role Assignments <span className="text-red-500">*</span>
                <span className="text-gray-400 dark:text-gray-500 font-normal ml-1">(multiple roles per branch allowed)</span>
              </label>
              <button type="button"
                onClick={() => { const firstBranch = branches[0]; if (firstBranch) append({ branchId: firstBranch.id, role: 'Sales' }); }}
                disabled={branches.length === 0}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                + Add Role Assignment
              </button>
            </div>
            {errors.assignments && !Array.isArray(errors.assignments) && (
              <p className="text-red-500 text-xs mb-2">{(errors.assignments as { message?: string }).message}</p>
            )}
            <div className="space-y-2">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <select aria-label="Branch" {...register(`assignments.${index}.branchId`)} className={inputCls}>
                    <option value="0">Select branch...</option>
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <select aria-label="Role" {...register(`assignments.${index}.role`)} className={inputCls}>
                    {grantable.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {fields.length > 1 && (
                    <button type="button" onClick={() => remove(index)}
                      className="text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 text-xs px-1 transition-colors">✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={busy || isSubmitting}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
          {busy ? 'Creating...' : 'Create Staff'}
        </button>
        <button type="button" onClick={onCancel}
          className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}
