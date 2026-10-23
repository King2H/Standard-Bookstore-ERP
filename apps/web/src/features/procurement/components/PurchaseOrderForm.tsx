import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Money, type PurchaseOrder } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { SearchPicker } from '../../../shared/components/SearchPicker.js';
import { useMyProfile } from '../../account/queries.js';
import { useOpenBranches } from '../../branches/queries.js';
import { useEveryLocation } from '../../locations/queries.js';
import { searchSuppliersToBuyFrom } from '../api.js';
import { usePurchaseOrder, useSavePurchaseOrder } from '../queries.js';
import { BookPicker } from './BookPicker.js';
import { amount } from './shared.js';

const isWhole = (v: string) => /^\d+$/.test(v) && Number(v) >= 1;

/** The form's fields, checked with the rules of the API's purchase-order contract. */
const LineSchema = z.object({
  // Every line names a book (was: a line without one was dropped without a word).
  bookId: z.number().nullable().refine((v) => Boolean(v), 'Choose a book for every line'),
  bookTitle: z.string(),
  quantity: z.string().trim().refine(isWhole, 'A quantity is a whole number of copies, at least 1'),
  unitCost: z.string().trim().regex(/^\d+(\.\d{1,4})?$/, 'A unit cost is an amount of 0 or more, e.g. 12.50'),
});
const OrderFormSchema = z.object({
  supplier: z.object({ id: z.number(), label: z.string() }).nullable().refine((v) => Boolean(v), 'Please select a supplier'),
  paymentTerms: z.enum(['credit', 'cash']),
  expectedDeliveryDate: z.string(),
  notes: z.string().max(2000, 'Notes can be at most 2000 characters'),
  receivingBranchId: z.string(),
  receivingLocationId: z.string(),
  lines: z.array(LineSchema).min(1, 'At least one line item is required'),
});
type OrderFormValues = z.infer<typeof OrderFormSchema>;

const EMPTY_LINE = { bookId: null, bookTitle: '', quantity: '1', unitCost: '0' };

function valuesOf(po: PurchaseOrder | undefined): OrderFormValues {
  if (!po) {
    return { supplier: null, paymentTerms: 'credit', expectedDeliveryDate: '', notes: '', receivingBranchId: '', receivingLocationId: '', lines: [{ ...EMPTY_LINE }] };
  }
  return {
    supplier: { id: po.supplierId, label: po.supplierName },
    paymentTerms: po.paymentTerms,
    expectedDeliveryDate: po.expectedDeliveryDate ?? '',
    notes: po.notes ?? '',
    receivingBranchId: po.receivingBranchId === po.branchId ? '' : String(po.receivingBranchId),
    receivingLocationId: po.receivingLocationId ? String(po.receivingLocationId) : '',
    lines: (po.lineItems ?? []).map((li) => ({ bookId: li.bookId, bookTitle: li.bookTitle, quantity: String(li.quantity), unitCost: String(li.unitCost) })),
  };
}

/** A line's total, when its quantity and cost are filled in. */
function lineTotal(line: { quantity: string; unitCost: string }): Money | null {
  return isWhole(line.quantity.trim()) && /^\d+(\.\d{1,4})?$/.test(line.unitCost.trim())
    ? Money.of(line.unitCost.trim()).times(Number(line.quantity))
    : null;
}

const SELECT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const SMALL = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

/** A new purchase order, or a draft's changes. Orders are in ETB. */
export function PurchaseOrderForm({ editing, onSaved, onCancel }: {
  editing?: PurchaseOrder;
  onSaved: (po: PurchaseOrder) => void;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const save = useSavePurchaseOrder(editing?.id);
  const { register, control, handleSubmit, watch, setValue, formState: { errors } } = useForm<OrderFormValues>({
    resolver: zodResolver(OrderFormSchema),
    defaultValues: valuesOf(editing),
  });
  const lines = useFieldArray({ control, name: 'lines' });
  const values = watch();

  // Only open branches receive goods (was: closed ones too, which the API refused).
  const { data: branches } = useOpenBranches();
  const receivingBranchId = values.receivingBranchId ? Number(values.receivingBranchId) : (me?.currentBranchId ?? null);
  // Any location of the receiving branch, its own included (was: only after choosing another branch).
  const { data: locations } = useEveryLocation(receivingBranchId);
  // The book search shows the receiving branch's stock when the session may read it
  // (its own branch, or access to all branches), else the session branch's (lib/scope.ts).
  const stockBranchId = receivingBranchId !== null && (me?.isAllBranches || receivingBranchId === me?.currentBranchId)
    ? receivingBranchId
    : (me?.currentBranchId ?? null);
  const stockBranchName = branches?.items.find((b) => b.id === stockBranchId)?.name ?? null;

  const totals = values.lines.map(lineTotal);
  const total = Money.sum(totals.map((t) => t ?? Money.ZERO));
  const lineProblem = values.lines
    .flatMap((_, i) => [errors.lines?.[i]?.bookId?.message, errors.lines?.[i]?.quantity?.message, errors.lines?.[i]?.unitCost?.message])
    .find(Boolean);
  const problem = errors.supplier?.message ?? errors.notes?.message ?? errors.lines?.message ?? lineProblem;

  function submit(v: OrderFormValues) {
    save.mutate({
      supplierId: v.supplier!.id,
      paymentTerms: v.paymentTerms,
      expectedDeliveryDate: v.expectedDeliveryDate || null,
      notes: v.notes || null,
      receivingBranchId: v.receivingBranchId ? Number(v.receivingBranchId) : null,
      receivingLocationId: v.receivingLocationId ? Number(v.receivingLocationId) : null,
      lineItems: v.lines.map((li) => ({ bookId: li.bookId!, quantity: Number(li.quantity), unitCost: li.unitCost.trim() })),
    }, {
      onSuccess: (po) => { showToast(editing ? 'PO updated' : 'PO created', 'success'); onSaved(po); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6 pb-8">
      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{editing ? 'Edit Purchase Order' : 'New Purchase Order'}</h2>
      </div>
      <form onSubmit={handleSubmit(submit)} className="space-y-5" noValidate>
        {problem && <p role="alert" className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{problem}</p>}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Order Details</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={LABEL}>Supplier *</label>
              <Controller control={control} name="supplier" render={({ field }) => (
                <SearchPicker value={field.value} onChange={field.onChange} search={searchSuppliersToBuyFrom} queryKey="po-form-suppliers"
                  placeholder="Type to search suppliers…" aria-label="Supplier" invalid={!!errors.supplier} className={SELECT} />
              )} />
            </div>
            <div>
              <label className={LABEL}>Currency</label>
              <p className="px-3 py-2 text-sm text-gray-900 dark:text-white">ETB</p>
            </div>
            <div>
              <label htmlFor="po-terms" className={LABEL}>Payment Terms</label>
              <select id="po-terms" {...register('paymentTerms')} className={SELECT}>
                <option value="credit">Credit (pay later)</option>
                <option value="cash">Cash (settles on receipt)</option>
              </select>
            </div>
            <div>
              <label htmlFor="po-expected" className={LABEL}>Expected Delivery</label>
              <input id="po-expected" type="date" {...register('expectedDeliveryDate')} className={SELECT} />
            </div>
            <div className="col-span-2">
              <label htmlFor="po-notes" className={LABEL}>Notes</label>
              <textarea id="po-notes" rows={2} {...register('notes')} aria-invalid={errors.notes ? true : undefined} className={`${SELECT} resize-none`} />
            </div>
            <div className="col-span-2">
              <label htmlFor="po-receiving-branch" className={LABEL}>Receiving Branch</label>
              <select id="po-receiving-branch" {...register('receivingBranchId', { onChange: () => setValue('receivingLocationId', '') })} className={SELECT}>
                <option value="">Same as order branch (default)</option>
                {(branches?.items ?? []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label htmlFor="po-receiving-location" className={LABEL}>Receiving Location</label>
              <select id="po-receiving-location" {...register('receivingLocationId')} className={SELECT}>
                <option value="">Default fulfillment location</option>
                {(locations?.items ?? []).map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Line Items</h3>
            <button type="button" onClick={() => lines.append({ ...EMPTY_LINE })} className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 font-medium">+ Add Item</button>
          </div>
          {lines.fields.map((field, i) => (
            <div key={field.id} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-5">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Book</label>
                <BookPicker
                  value={{ bookId: values.lines[i]?.bookId ?? null, bookTitle: values.lines[i]?.bookTitle ?? '' }}
                  onChange={({ bookId, bookTitle }) => { setValue(`lines.${i}.bookId`, bookId); setValue(`lines.${i}.bookTitle`, bookTitle); }}
                  branchId={stockBranchId !== null && stockBranchId !== me?.currentBranchId ? stockBranchId : undefined}
                  branchName={stockBranchName}
                  invalid={!!errors.lines?.[i]?.bookId}
                />
              </div>
              <div className="col-span-2">
                <label htmlFor={`po-line-${i}-qty`} className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Qty</label>
                <input id={`po-line-${i}-qty`} type="number" min={1} {...register(`lines.${i}.quantity`)} aria-invalid={errors.lines?.[i]?.quantity ? true : undefined} className={SMALL} />
              </div>
              <div className="col-span-3">
                <label htmlFor={`po-line-${i}-cost`} className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit Cost</label>
                <input id={`po-line-${i}-cost`} type="number" min={0} step="0.01" {...register(`lines.${i}.unitCost`)} aria-invalid={errors.lines?.[i]?.unitCost ? true : undefined} className={SMALL} />
              </div>
              <div className="col-span-1 text-right text-xs text-gray-500 dark:text-gray-400 pb-2">
                {totals[i] ? amount(totals[i]!) : '—'}
              </div>
              <div className="col-span-1 pb-1">
                {lines.fields.length > 1 && <button type="button" onClick={() => lines.remove(i)} aria-label="Remove line" className="text-red-500 hover:text-red-700 text-sm">✕</button>}
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-2 border-t border-gray-100 dark:border-gray-800">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Total: ETB {amount(total)}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
          <button type="submit" disabled={save.isPending} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{save.isPending ? 'Saving...' : 'Save as Draft'}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * A draft's changes, on the whole order: a listed order carries no lines (was:
 * the list's Edit opened an empty form, and saving replaced the order's lines).
 */
export function EditPurchaseOrder({ id, onSaved, onCancel }: { id: string; onSaved: (po: PurchaseOrder) => void; onCancel: () => void }) {
  const { data: po } = usePurchaseOrder(id);
  if (!po) return <div className="p-8 text-center text-gray-400">Loading...</div>;
  return <PurchaseOrderForm editing={po} onSaved={onSaved} onCancel={onCancel} />;
}
