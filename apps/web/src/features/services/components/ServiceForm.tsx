import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ServiceRequestSchema, type Service, type ServiceRequest } from '@bms/shared';
import { useCurrency } from '../../../lib/useCurrency.js';
import { Drawer } from '../../../shared/components/Drawer.js';
import { useBookFormats } from '../../catalogReference/queries.js';
import { isCost, isFee } from '../rules.js';

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const BUTTON = 'flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

/** The form's fields, checked with the rules of the API's contract. */
const FormSchema = z.object({
  code: ServiceRequestSchema.shape.code,
  name: ServiceRequestSchema.shape.name,
  formatId: z.string().min(1, 'Pick the cover'),
  fee: z.string().refine(isFee, 'An amount above 0, e.g. 250.00'),
  standardCost: z.string().refine(isCost, 'An amount, 0 or more'),
  discountable: z.boolean(),
  turnaroundDays: z.string().regex(/^\d+$/, 'Whole days, 0 or more').refine((v) => Number(v) <= 365, 'At most 365 days'),
});
type FormValues = z.infer<typeof FormSchema>;

/** Adds or edits a binding service (#169): its code, the cover it produces, the shop's fee and cost, and its turnaround. */
export function ServiceForm({ editing, saving, error, onSave, onClose }: {
  editing: Service | null;
  saving: boolean;
  /** What the API refused, if it did. */
  error: string;
  onSave: (body: ServiceRequest) => void;
  onClose: () => void;
}) {
  const currency = useCurrency();
  const { data: formats } = useBookFormats();
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      code: editing?.code ?? '',
      name: editing?.name ?? '',
      formatId: editing?.formatId ? String(editing.formatId) : '',
      fee: editing ? editing.fee.toFixed(2) : '',
      standardCost: editing ? editing.standardCost.toFixed(2) : '0.00',
      discountable: editing?.discountable ?? false,
      turnaroundDays: String(editing?.turnaroundDays ?? 0),
    },
  });
  const submit = handleSubmit((v) => onSave({
    code: v.code.trim(), name: v.name.trim(), kind: 'binding', formatId: Number(v.formatId), fee: v.fee.trim(),
    standardCost: v.standardCost.trim(), discountable: v.discountable, turnaroundDays: Number(v.turnaroundDays),
  }));
  const fieldError = (name: keyof FormValues) => errors[name]
    ? <p role="alert" className="text-xs mt-1 text-red-500">{errors[name]?.message}</p>
    : null;

  return (
    <Drawer title={editing ? `Edit ${editing.name}` : 'New Service'} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className={`${BUTTON} border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300`}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={saving} className={`${BUTTON} bg-blue-600 hover:bg-blue-700 text-white`}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4" noValidate>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div>
          <label htmlFor="service-code" className={LABEL}>Code *</label>
          <input id="service-code" {...register('code')} placeholder="e.g. BIND-LEATHER" aria-invalid={!!errors.code || undefined} className={`${INPUT} uppercase`} />
          {fieldError('code')}
        </div>
        <div>
          <label htmlFor="service-name" className={LABEL}>Name *</label>
          <input id="service-name" {...register('name')} placeholder="e.g. Leather binding" aria-invalid={!!errors.name || undefined} className={INPUT} />
          {fieldError('name')}
        </div>
        <div>
          <label htmlFor="service-format" className={LABEL}>Cover it produces *</label>
          <select id="service-format" {...register('formatId')} aria-invalid={!!errors.formatId || undefined} className={INPUT}>
            <option value="">Pick a cover…</option>
            {(formats?.items ?? []).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          {fieldError('formatId')}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="service-fee" className={LABEL}>{`Fee (${currency}) *`}</label>
            <input id="service-fee" inputMode="decimal" {...register('fee')} aria-invalid={!!errors.fee || undefined} className={INPUT} />
            {fieldError('fee')}
          </div>
          <div>
            <label htmlFor="service-cost" className={LABEL}>{`Standard cost (${currency}) *`}</label>
            <input id="service-cost" inputMode="decimal" {...register('standardCost')} aria-invalid={!!errors.standardCost || undefined} className={INPUT} />
            {fieldError('standardCost')}
          </div>
        </div>
        <div>
          <label htmlFor="service-days" className={LABEL}>Turnaround (days) *</label>
          <input id="service-days" inputMode="numeric" {...register('turnaroundDays')} aria-invalid={!!errors.turnaroundDays || undefined} className={INPUT} />
          {fieldError('turnaroundDays')}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" {...register('discountable')} className="rounded-sm border-gray-300 dark:border-gray-600" />
          A sale may discount the fee
        </label>
        <p className="text-xs text-gray-400">The fee is the shop's; a branch may set its own. The standard cost is recorded on each sale.</p>
      </form>
    </Drawer>
  );
}
