import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CreateSupplierRequestSchema, type CreateSupplierRequest, type Supplier } from '@bms/shared';
import { SearchPicker } from '../../../shared/components/SearchPicker.js';
import { searchPublishers } from '../../catalogReference/api.js';

const create = CreateSupplierRequestSchema.shape;

/** The form's fields, checked with the rules of the API's create-supplier contract. */
export const SupplierFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter the supplier name'),
    supplierType: create.supplierType,
    publisher: z.object({ id: z.number().int(), label: z.string() }).nullable(),
    email: z.union([z.literal(''), z.email('Enter a valid email address')]),
    phone: z.string(),
    leadTimeDays: z.number({ error: 'Enter the lead time in days' }).int('Whole days only').min(0, 'Cannot be negative'),
    pricingTerms: z.string(),
  })
  .refine((f) => f.supplierType !== 'publisher' || f.publisher !== null, {
    path: ['publisher'],
    message: 'Pick the publisher',
  });
export type SupplierFormValues = z.infer<typeof SupplierFormSchema>;

const EMPTY: SupplierFormValues = {
  name: '', supplierType: 'external', publisher: null, email: '', phone: '', leadTimeDays: 7, pricingTerms: '',
};

export function formValuesOf(s: Supplier): SupplierFormValues {
  const contact = s.contactInfo as { phone?: unknown; email?: unknown };
  return {
    name: s.name,
    supplierType: s.supplierType,
    publisher: s.publisherId !== null ? { id: s.publisherId, label: s.publisherName ?? `Publisher #${s.publisherId}` } : null,
    email: typeof contact.email === 'string' ? contact.email : '',
    phone: typeof contact.phone === 'string' ? contact.phone : '',
    leadTimeDays: s.leadTimeDays,
    pricingTerms: s.pricingTerms ?? '',
  };
}

/** The request body for the form's values: the same for creating and for editing a supplier. */
export function toSupplierRequest(f: SupplierFormValues): CreateSupplierRequest {
  return {
    name: f.name,
    contactInfo: { phone: f.phone, email: f.email },
    leadTimeDays: f.leadTimeDays,
    pricingTerms: f.pricingTerms || null,
    supplierType: f.supplierType,
    publisherId: f.supplierType === 'publisher' ? f.publisher?.id ?? null : null,
  };
}

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-red-500 text-xs mt-1">{message}</p> : null;
}

/** The drawer to create or edit a supplier. */
export function SupplierForm({ editing, busy, onSubmit, onClose }: {
  editing: Supplier | null;
  busy: boolean;
  onSubmit: (body: CreateSupplierRequest) => void;
  onClose: () => void;
}) {
  const { register, control, handleSubmit, watch, setValue, formState: { errors } } = useForm<SupplierFormValues>({
    resolver: zodResolver(SupplierFormSchema),
    defaultValues: editing ? formValuesOf(editing) : EMPTY,
  });
  const supplierType = watch('supplierType');

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl flex flex-col overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{editing ? 'Edit Supplier' : 'New Supplier'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">x</button>
        </div>
        <form onSubmit={handleSubmit((f) => onSubmit(toSupplierRequest(f)))} noValidate className="flex-1 p-6 space-y-4">
          <div>
            <label htmlFor="supplier-name" className={LABEL}>Name *</label>
            <input id="supplier-name" {...register('name')} className={INPUT} />
            <FieldError message={errors.name?.message} />
          </div>
          <div>
            <label htmlFor="supplier-type" className={LABEL}>Supplier Type *</label>
            <select
              id="supplier-type"
              {...register('supplierType', { onChange: () => setValue('publisher', null) })}
              className={INPUT}
            >
              <option value="external">External (Distributor / Wholesaler)</option>
              <option value="publisher">Publisher (Direct from Publisher)</option>
            </select>
          </div>
          {supplierType === 'publisher' && (
            <div>
              <label className={LABEL}>Linked Publisher *</label>
              <Controller
                control={control}
                name="publisher"
                render={({ field }) => (
                  <SearchPicker
                    aria-label="Linked Publisher"
                    value={field.value}
                    onChange={field.onChange}
                    queryKey="publishers"
                    search={async (q) => (await searchPublishers(q)).items.map((p) => ({ id: p.id, label: p.name }))}
                    placeholder="Type the publisher's name…"
                    invalid={!!errors.publisher}
                    className={INPUT}
                  />
                )}
              />
              <FieldError message={errors.publisher?.message} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="supplier-email" className={LABEL}>Email</label>
              <input id="supplier-email" type="email" {...register('email')} className={INPUT} />
              <FieldError message={errors.email?.message} />
            </div>
            <div>
              <label htmlFor="supplier-phone" className={LABEL}>Phone</label>
              <input id="supplier-phone" {...register('phone')} className={INPUT} />
            </div>
          </div>
          <div>
            <label htmlFor="supplier-lead-time" className={LABEL}>Lead Time (days) *</label>
            <input id="supplier-lead-time" type="number" min={0} {...register('leadTimeDays', { valueAsNumber: true })} className={INPUT} />
            <FieldError message={errors.leadTimeDays?.message} />
          </div>
          <div>
            <label htmlFor="supplier-pricing-terms" className={LABEL}>Pricing Terms</label>
            <textarea id="supplier-pricing-terms" rows={2} {...register('pricingTerms')} className={`${INPUT} resize-none`} />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{busy ? 'Saving...' : editing ? 'Save Changes' : 'Create Supplier'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
