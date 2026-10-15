import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CreateBranchRequestSchema } from '@bms/shared';

const create = CreateBranchRequestSchema.shape;

/** The new-branch form, checked with the rules of the API's create-branch contract. */
export const BranchFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(create.name.maxLength ?? 100, 'At most 100 characters'),
  address: z.string().trim().min(1, 'Address is required'),
  contactInfo: z.object({
    phone: z.string(),
    email: z.union([z.literal(''), z.email('Invalid email')]),
  }),
});
export type BranchFormValues = z.infer<typeof BranchFormSchema>;

const EMPTY: BranchFormValues = { name: '', address: '', contactInfo: { phone: '', email: '' } };

const INPUT = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

export function BranchForm({ busy, error, onSubmit, onCancel }: {
  busy: boolean;
  /** The API's refusal, shown above the fields. */
  error: string | null;
  onSubmit: (values: BranchFormValues) => void;
  onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<BranchFormValues>({
    resolver: zodResolver(BranchFormSchema),
    defaultValues: EMPTY,
  });

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-6 space-y-4 shadow-xs"
    >
      <h2 className="font-semibold text-gray-800 dark:text-gray-100">Create Branch</h2>

      {error && (
        <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="branch-name" className={LABEL}>Name <span className="text-red-500">*</span></label>
          <input id="branch-name" {...register('name')} placeholder="e.g. Downtown Branch" className={INPUT} />
          {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
        </div>
        <div>
          <label htmlFor="branch-address" className={LABEL}>Address <span className="text-red-500">*</span></label>
          <input id="branch-address" {...register('address')} placeholder="e.g. 123 Main St, City" className={INPUT} />
          {errors.address && <p className="text-red-500 text-xs mt-1">{errors.address.message}</p>}
        </div>
        <div>
          <label htmlFor="branch-phone" className={LABEL}>Phone</label>
          <input id="branch-phone" {...register('contactInfo.phone')} placeholder="e.g. 555-0100" className={INPUT} />
        </div>
        <div>
          <label htmlFor="branch-email" className={LABEL}>Email</label>
          <input id="branch-email" {...register('contactInfo.email')} type="email" placeholder="e.g. branch@store.com" className={INPUT} />
          {errors.contactInfo?.email && <p className="text-red-500 text-xs mt-1">{errors.contactInfo.email.message}</p>}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || isSubmitting}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Creating...' : 'Create Branch'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
