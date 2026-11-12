import { useRef, useState } from 'react';
import type { Service } from '@bms/shared';
import { useCurrency } from '../../../lib/useCurrency.js';
import { SearchPicker } from '../../../shared/components/SearchPicker.js';
import { PICKER_PAGE_SIZE } from '../../../shared/picker.js';
import { listServices } from '../api.js';
import { bindingTotal, choiceFor, type BindingChoice } from '../binding.js';

/** The service a binding is for, as the choice keeps it. */
type Picked = Omit<BindingChoice, 'quantity' | 'discountPct'>;

const pickedOf = (s: Service): Picked => {
  const c = choiceFor(s, 1);
  return { serviceId: c.serviceId, code: c.code, name: c.name, unitFee: c.unitFee, discountable: c.discountable };
};

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

/**
 * Binding for a sale's book line (#169 PR 2): which service, for how many of
 * the line's copies (owner decision 2a), and a discount only where the
 * service allows it, within the seller's line limit (3a). An exchange gives
 * no discount (PR 4, 2a).
 */
export function BindingDialog({ bookTitle, bookQuantity, value, maxDiscountPct, discounts = true, onSave, onRemove, onClose }: {
  bookTitle: string;
  bookQuantity: number;
  value?: BindingChoice;
  /** The seller's line discount limit; null while unknown. */
  maxDiscountPct: number | null;
  /** False where the sale carries no discount, as an exchange. */
  discounts?: boolean;
  onSave: (choice: BindingChoice) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const currency = useCurrency();
  // Any active binding is found by typing its name or code (#266; was: a dropdown of the first 100).
  const found = useRef(new Map<number, Service>());
  const [service, setService] = useState<Picked | null>(value ? {
    serviceId: value.serviceId, code: value.code, name: value.name, unitFee: value.unitFee, discountable: value.discountable,
  } : null);
  const [quantity, setQuantity] = useState(String(value?.quantity ?? bookQuantity));
  const [discount, setDiscount] = useState(value && value.discountPct > 0 ? String(value.discountPct) : '');
  const [error, setError] = useState('');
  const discountable = discounts && !!service?.discountable;

  function save() {
    if (!service) { setError('Pick the binding'); return; }
    const qty = Number(quantity);
    if (!/^\d+$/.test(quantity.trim()) || qty < 1 || qty > bookQuantity) { setError(`Copies to bind: 1 to ${bookQuantity}`); return; }
    const pct = discount.trim() === '' ? 0 : Number(discount);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) { setError('The discount is a percentage, 0 to 100'); return; }
    if (maxDiscountPct !== null && pct > maxDiscountPct) { setError(`The discount is more than your limit of ${maxDiscountPct}%`); return; }
    onSave({ ...service, quantity: qty, discountable, discountPct: discountable ? pct : 0 });
  }

  const preview = service && /^\d+$/.test(quantity.trim()) && Number(quantity) >= 1
    ? bindingTotal({ ...service, quantity: Number(quantity), discountable, discountPct: discountable ? Number(discount) || 0 : 0 })
    : null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="binding-title" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="binding-title" className="text-base font-semibold text-gray-900 dark:text-white">Binding: {bookTitle}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">The book is sold as usual; the binding is its own line, for a named customer, who is called when it is ready.</p>
        <div>
          <label htmlFor="binding-service" className={LABEL}>Binding</label>
          <SearchPicker id="binding-service" queryKey="services:active" className={INPUT} placeholder="Type a binding…"
            value={service ? { id: service.serviceId, label: service.name } : null}
            onChange={(o) => {
              const s = o ? found.current.get(o.id) : undefined;
              setService(s ? pickedOf(s) : null);
              setError('');
            }}
            search={async (q, page) => {
              const res = await listServices({ status: 'active', q: q || undefined, page, pageSize: PICKER_PAGE_SIZE });
              for (const s of res.items) found.current.set(s.id, s);
              return {
                items: res.items.map((s) => ({ id: s.id, label: `${s.name} — ${currency} ${s.effectiveFee.toFixed(2)}, ready in ${s.turnaroundDays} ${s.turnaroundDays === 1 ? 'day' : 'days'}` })),
                total: res.total,
              };
            }} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="binding-qty" className={LABEL}>{`Copies (of ${bookQuantity})`}</label>
            <input id="binding-qty" inputMode="numeric" value={quantity} onChange={(e) => { setQuantity(e.target.value); setError(''); }} className={INPUT} />
          </div>
          {discountable && (
            <div>
              <label htmlFor="binding-discount" className={LABEL}>Discount (%)</label>
              <input id="binding-discount" inputMode="decimal" value={discount} onChange={(e) => { setDiscount(e.target.value); setError(''); }} className={INPUT} />
            </div>
          )}
        </div>
        {service && !discountable && <p className="text-xs text-gray-400">{discounts ? 'This fee is not discounted.' : 'An exchange gives no discount on the fee.'}</p>}
        {preview && <p className="text-sm text-gray-700 dark:text-gray-300">{`Binding total: ${currency} ${preview.toFixed(2)}`}</p>}
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2 justify-end pt-1">
          {value && (
            <button type="button" onClick={onRemove} className="mr-auto px-3 py-2 text-sm rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">Remove binding</button>
          )}
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" className="px-4 py-2 text-sm rounded-lg text-white bg-blue-600 hover:bg-blue-700">Save</button>
        </div>
      </form>
    </div>
  );
}
