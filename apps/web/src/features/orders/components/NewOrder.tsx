import { Fragment, useEffect, useRef, useState } from 'react';
import { Money, type BookWithAvailabilitySchema, type Customer, type Order } from '@bms/shared';
import type { z } from 'zod';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import PaymentMethodTabs from '../../../components/PaymentMethodTabs.js';
import PaymentProofFields from '../../../components/PaymentProofFields.js';
import { useToast } from '../../../components/Toast.js';
import { getCurrentBranchId } from '../../../lib/api.js';
import { type PaymentMethodCode } from '../../../lib/paymentMethods.js';
import { EMPTY_PROOF, type PaymentProof } from '../../../lib/paymentProof.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import { useCustomer } from '../../customers/queries.js';
import { useLocations } from '../../locations/queries.js';
import { maxDiscountPct } from '../../pos/rules.js';
import { useEffectiveSetting } from '../../settings/queries.js';
import { bindingTotal, fitTo } from '../../services/binding.js';
import { BindingDialog } from '../../services/components/BindingDialog.js';
import { discountProblem, lineInput, lineTotal, orderSubtotal, type OrderLine } from '../lines.js';
import { useBooksForOrder, useConfirmOrder, useCreateOrder, useCustomersForOrder, useOrder, useUpdateOrder } from '../queries.js';
import { canCreateOrder, cashConfirmBody, cashPaymentProblem } from '../rules.js';

type Book = z.infer<typeof BookWithAvailabilitySchema>;
type SaleType = 'cash_sale' | 'credit_sale';
type Channel = 'in_store' | 'phone' | 'online';

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const CARD = 'bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4';

/** A draft's line as the form holds it (#174): its discount as it was given, its binding as chosen. */
function lineOf(l: NonNullable<Order['lineItems']>[number]): OrderLine {
  return {
    bookId: l.bookId, bookTitle: l.bookTitle, quantity: l.quantity, unitPrice: Money.of(l.unitPrice),
    discountType: l.discountType, discountMode: l.discountMode,
    discount: l.discountMode === 'Percentage' ? String(l.discountPct) : Money.of(l.discountAmount).toFixed(),
    availableStock: null,
    specialOrder: l.specialOrder,
    // A fee with no discount reads as one that takes none; "Change" picks the service again from the list.
    service: l.service ? {
      serviceId: l.service.serviceId, code: l.service.serviceCode, name: l.service.serviceName, unitFee: l.service.unitFee,
      discountable: l.service.discountAmount > 0, quantity: l.service.quantity,
      discountPct: l.service.discountAmount > 0 ? Money.of(l.service.discountAmount).times(100).dividedBy(Money.of(l.service.unitFee).times(l.service.quantity).toFixed(2)).round(2).toNumber() : 0,
    } : undefined,
  };
}

/**
 * A new order, created and confirmed in one step: a cash order is paid now,
 * a credit order owes by its due date. If confirming fails the order stays a
 * draft, the form is cleared and the list shows it (owner decision 3a), so a
 * retry never creates a second order. With `draftId`, a draft opens as it was
 * entered, to be saved again or saved and confirmed (#174, decision 1a).
 */
export function NewOrder({ onDone, draftId = null }: { onDone: () => void; draftId?: string | null }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const branchId = getCurrentBranchId();

  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [saleType, setSaleType] = useState<SaleType>('cash_sale');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodCode>('cash');
  const [proof, setProof] = useState<PaymentProof>(EMPTY_PROOF);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState('');
  // A credit order's part paid now (#174): paid by paymentMethod, with its proof.
  const [deposit, setDeposit] = useState('');
  const [channel, setChannel] = useState<Channel>('in_store');
  const [bookSearch, setBookSearch] = useState('');
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [bindingFor, setBindingFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: locData } = useLocations(branchId);
  const locations = locData?.items ?? [];
  // The branch's default location (or its first) until staff pick another.
  const locationId = selectedLocationId ?? locations.find((l) => l.isDefaultFulfillment)?.id ?? locations[0]?.id ?? null;
  const { data: bookResults } = useBooksForOrder(bookSearch, locationId);
  const { data: customerResults } = useCustomersForOrder(customerSearch);
  // With Bank Accounts on, a bank payment names the account it went to (#21).
  const { accounts: bankAccounts, required: bankAccountRequired } = useBranchBankAccounts(branchId, paymentMethod === 'bank');
  // The most this person may discount a line, as the API checks it; unknown until the setting loads.
  const discountLimits = useEffectiveSetting('max_line_discount_pct');
  const maxPct = discountLimits === undefined ? null : maxDiscountPct(discountLimits, me);
  const createOrder = useCreateOrder();
  const updateOrder = useUpdateOrder();
  const confirmOrder = useConfirmOrder();
  const { data: draft } = useOrder(draftId ?? '', draftId !== null);
  const { data: draftCustomer } = useCustomer(draft?.customerId ?? null);
  const [notes, setNotes] = useState<string | null>(null);
  const filled = useRef(false);
  // The draft fills the form once, when it has loaded; its customer when that has.
  useEffect(() => {
    if (!draft?.lineItems || filled.current) return;
    filled.current = true;
    setSaleType(draft.saleType);
    setChannel(draft.channel as Channel);
    setSelectedLocationId(draft.locationId);
    setNotes(draft.notes);
    setLines(draft.lineItems.map(lineOf));
  }, [draft]);
  useEffect(() => { if (draftCustomer) setSelectedCustomer(draftCustomer); }, [draftCustomer]);

  const setLine = (bookId: number, change: Partial<OrderLine>) =>
    setLines((ls) => ls.map((l) => {
      if (l.bookId !== bookId) return l;
      const next = { ...l, ...change };
      // A binding is for no more copies than the line has.
      return { ...next, service: 'service' in change ? change.service : fitTo(l.service, next.quantity) };
    }));

  /** A special order is a credit sale's line, with no binding until its books arrive (#174). */
  function setSpecial(bookId: number, special: boolean) {
    setLine(bookId, { specialOrder: special, ...(special && { service: undefined }) });
    if (special) setSaleType('credit_sale');
  }

  function addItem(book: Book) {
    const availableStock = book.availability?.available ?? null;
    const existing = lines.find((l) => l.bookId === book.id);
    if (existing) {
      if (!existing.specialOrder && availableStock != null && existing.quantity >= availableStock) {
        showToast(`Only ${availableStock} in stock for "${book.title}"`, 'error');
        return;
      }
      setLine(book.id, { quantity: existing.quantity + 1 });
    } else {
      // Not in stock: ordered for the customer, as a credit sale (#174, decision 1a).
      const special = availableStock != null && availableStock <= 0;
      if (special) {
        setSaleType('credit_sale');
        showToast(`"${book.title}" is out of stock: added as a special order (a credit sale)`, 'success');
      }
      setLines((ls) => [...ls, {
        bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: Money.of(book.branchPrice ?? book.defaultPrice ?? 0),
        discountType: 'Normal', discountMode: 'Percentage', discount: '0', availableStock, ...(special && { specialOrder: true }),
      }]);
    }
    setBookSearch('');
  }

  const subtotal = orderSubtotal(lines);

  function reset() {
    setLines([]); setSelectedCustomer(null); setPaymentMethod('cash'); setDueDate(''); setDeposit('');
    setProof(EMPTY_PROOF); setBankAccountId(null);
  }

  /** What stops the order before it is sent, or null. */
  function problem(): string | null {
    if (lines.length === 0) return 'Add at least one item';
    if (saleType === 'credit_sale' && !selectedCustomer) return 'Credit sales require a customer';
    if (lines.some((l) => l.service) && !selectedCustomer) return 'A binding needs a customer, who is called when it is ready';
    if (saleType === 'credit_sale' && !dueDate) return 'Credit sales require a due date';
    if (saleType === 'cash_sale' && lines.some((l) => l.specialOrder)) return 'A special order is a credit sale: choose Credit Sale';
    if (saleType === 'credit_sale' && deposit.trim() !== '') {
      if (!/^\d+(\.\d{1,2})?$/.test(deposit.trim()) || !Money.of(deposit.trim()).greaterThan(0)) return 'Enter the deposit as an amount, e.g. 20.00';
      if (Money.of(deposit.trim()).greaterThan(subtotal)) return 'The deposit is at most the order\'s total';
      return cashPaymentProblem(paymentMethod, proof, bankAccountId, bankAccountRequired);
    }
    const discounts = discountProblem(lines, maxPct);
    if (discounts) return discounts;
    if (saleType === 'cash_sale' && paymentMethod === 'store_credit') {
      if (!selectedCustomer) return 'Store credit payment requires a customer — please select one above';
      // The API takes the order's total from the account under lock; this says so before it is sent.
      if (Money.of(selectedCustomer.storeCreditBalance).lessThan(subtotal)) {
        return `Only ${Money.of(selectedCustomer.storeCreditBalance).toFixed()} of store credit is available`;
      }
    }
    return saleType === 'cash_sale' ? cashPaymentProblem(paymentMethod, proof, bankAccountId, bankAccountRequired) : null;
  }

  /** The order as the form sends it; a draft keeps its notes. */
  const orderBody = () => ({
    customerId: selectedCustomer?.id ?? null,
    channel,
    saleType,
    locationId: locationId ?? undefined,
    ...(draftId !== null && { notes: notes ?? undefined }),
    items: lines.map(lineInput),
  });
  const save = () => (draftId !== null ? updateOrder.mutateAsync({ id: draftId, body: orderBody() }) : createOrder.mutateAsync(orderBody()));

  /** A draft saved as it is now, not yet confirmed (#174). */
  async function saveDraft() {
    const stop = lines.length === 0 ? 'Add at least one item'
      : saleType === 'credit_sale' && !selectedCustomer ? 'Credit sales require a customer'
      : saleType === 'cash_sale' && lines.some((l) => l.specialOrder) ? 'A special order is a credit sale: choose Credit Sale'
      : discountProblem(lines, maxPct);
    if (stop) { showToast(stop, 'error'); return; }
    setBusy(true);
    try {
      const saved = await save();
      showToast(`Draft ${saved.orderNumber} saved`, 'success');
      onDone();
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitOrder() {
    const stop = problem();
    if (stop) { showToast(stop, 'error'); return; }
    setBusy(true);
    try {
      let draft;
      try {
        draft = await save();
      } catch (e) {
        showToast((e as Error).message, 'error');
        return;
      }
      try {
        const confirmed = await confirmOrder.mutateAsync({
          id: draft.id,
          body: saleType === 'cash_sale' ? cashConfirmBody(paymentMethod, proof, bankAccountId) : {
            dueDate,
            ...(deposit.trim() !== '' && { deposit: Number(deposit.trim()), ...cashConfirmBody(paymentMethod, proof, bankAccountId) }),
          },
        });
        showToast(`Order ${confirmed.orderNumber} ${draftId !== null ? 'saved' : 'created'} & ${saleType === 'cash_sale' ? 'paid' : 'confirmed'}`, 'success');
      } catch (e) {
        showToast(`Order ${draft.orderNumber} was saved as a draft: ${(e as Error).message} Confirm it in the list.`, 'error');
      }
      reset();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (!canCreateOrder(me)) return null;
  if (draftId !== null && !draft) return <p className="p-4 text-sm text-gray-400">Loading...</p>;
  const customers = customerResults?.items ?? [];
  const books = bookResults?.items ?? [];

  return (
    <div className="flex-1 overflow-auto p-4 pb-6 max-w-2xl mx-auto w-full space-y-4">
      {draft && <h2 className="text-base font-semibold text-gray-900 dark:text-white">Editing {draft.orderNumber}</h2>}
      <div className={`${CARD} space-y-2`}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Customer (optional)</h3>
        {selectedCustomer ? (
          <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
            <span className="text-sm text-blue-700 dark:text-blue-300">{selectedCustomer.fullName} ({selectedCustomer.customerCode})</span>
            <button onClick={() => setSelectedCustomer(null)} className="text-gray-400 hover:text-red-500 text-sm">×</button>
          </div>
        ) : (
          <div className="relative">
            <input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Search customer..." className={INPUT} />
            {customers.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                {customers.map((c) => (
                  <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <span className="font-medium text-gray-900 dark:text-white">{c.fullName}</span>
                    <span className="text-gray-500 dark:text-gray-400 ml-2 text-xs">{c.customerCode}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`${CARD} space-y-2`}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Sale Type</h3>
        <div className="flex gap-2">
          {([['cash_sale', '💵 Cash Sale'], ['credit_sale', '📋 Credit Sale']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setSaleType(v)}
              className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${saleType === v ? (v === 'credit_sale' ? 'bg-amber-600 text-white' : 'bg-green-600 text-white') : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
        {saleType === 'credit_sale' && !selectedCustomer && (
          <p className="text-xs text-amber-600 dark:text-amber-400">⚠ Credit sales require a customer — please select one above.</p>
        )}
        {/* A credit order owes by its due date; the API takes today (its date) or later. */}
        {saleType === 'credit_sale' && (
          <div className="pt-1 space-y-1">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Due Date</p>
            <input type="date" aria-label="Due date" value={dueDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDueDate(e.target.value)} className={INPUT} />
            {/* A deposit is paid now, the rest owed (#174, decision 2a). */}
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 pt-1">Deposit (optional)</p>
            <input type="text" inputMode="decimal" aria-label="Deposit (optional)" value={deposit} placeholder="0.00" onChange={(e) => setDeposit(e.target.value)} className={INPUT} />
            {deposit.trim() !== '' && (
              <>
                <PaymentMethodTabs methods={['cash', 'bank', 'mobile', 'store_credit']} value={paymentMethod} onChange={setPaymentMethod} columns={4} />
                {paymentMethod === 'bank' && bankAccountRequired && (
                  <BankAccountSelect accounts={bankAccounts} value={bankAccountId} onChange={setBankAccountId} />
                )}
                <PaymentProofFields method={paymentMethod} value={proof} onChange={setProof} />
              </>
            )}
          </div>
        )}
        {/* A cash order is paid at once: how, and for bank and Telebirr the proof. */}
        {saleType === 'cash_sale' && (
          <div className="pt-1 space-y-1">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Payment Method</p>
            <PaymentMethodTabs methods={['cash', 'bank', 'mobile', 'store_credit']} value={paymentMethod} onChange={setPaymentMethod} columns={4} />
            {paymentMethod === 'store_credit' && !selectedCustomer && (
              <p className="text-xs text-amber-600 dark:text-amber-400">⚠ Store credit requires a customer — please select one above.</p>
            )}
            {paymentMethod === 'bank' && bankAccountRequired && (
              <BankAccountSelect accounts={bankAccounts} value={bankAccountId} onChange={setBankAccountId} />
            )}
            <PaymentProofFields method={paymentMethod} value={proof} onChange={setProof} />
          </div>
        )}
      </div>

      <div className={`${CARD} space-y-2`}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Channel</h3>
        <div className="flex gap-2">
          {(['in_store', 'phone', 'online'] as const).map((c) => (
            <button key={c} onClick={() => setChannel(c)} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${channel === c ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
              {c.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {locations.length > 1 && (
        <div className={`${CARD} space-y-2`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Fulfillment Location</h3>
          <select aria-label="Fulfillment location" value={locationId ?? ''} onChange={(e) => setSelectedLocationId(e.target.value ? Number(e.target.value) : null)} className={INPUT}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>
            ))}
          </select>
        </div>
      )}

      <div className={`${CARD} space-y-3`}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Items</h3>
        <div className="relative">
          <input value={bookSearch} onChange={(e) => setBookSearch(e.target.value)} placeholder="Search books to add..." className={INPUT} />
          {books.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
              {books.map((b) => (
                <button key={b.id} onClick={() => addItem(b)}
                  className="w-full text-left px-3 py-2 text-sm transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-blue-50 dark:hover:bg-blue-950/30">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-gray-900 dark:text-white truncate min-w-0">{b.title}</p>
                    {b.availability != null && (
                      <span className={`text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded-full ${b.availability.available === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : b.availability.available <= 3 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'}`}>
                        {b.availability.available === 0 ? 'Out of stock · special order' : `${b.availability.available} avail`}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{b.isbn} · {currency} {Money.of(b.branchPrice ?? b.defaultPrice ?? 0).toFixed()}</p>
                  {b.availability != null ? (
                    <p className="text-xs text-gray-400 mt-0.5">
                      📍 {b.availability.locationName ?? 'Location'} · On hand: {b.availability.onHand} · Reserved: {b.availability.reserved} · Available: {b.availability.available}
                    </p>
                  ) : b.stockQuantity != null && (
                    <p className={`text-xs font-medium mt-0.5 ${b.stockQuantity === 0 ? 'text-red-600 dark:text-red-400' : b.stockQuantity <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                      {b.stockQuantity === 0 ? '⚠ Out of stock' : b.stockQuantity <= 3 ? `⚠ Only ${b.stockQuantity} left` : `✓ ${b.stockQuantity} in stock`}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {lines.length > 0 && (
          <div className="space-y-2">
            {lines.map((item) => (
              <Fragment key={item.bookId}>
              <div className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{item.bookTitle}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{currency} {item.unitPrice.toFixed()} each</p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setLine(item.bookId, { quantity: Math.max(1, item.quantity - 1) })} aria-label={`One fewer ${item.bookTitle}`}
                    className="w-6 h-6 rounded-sm bg-gray-200 dark:bg-gray-700 text-sm font-bold">-</button>
                  <span aria-label={`Quantity of ${item.bookTitle}`} className="w-8 text-center text-sm">{item.quantity}</span>
                  <button
                    onClick={() => {
                      if (!item.specialOrder && item.availableStock != null && item.quantity >= item.availableStock) {
                        showToast(`Only ${item.availableStock} in stock for "${item.bookTitle}"`, 'error');
                        return;
                      }
                      setLine(item.bookId, { quantity: item.quantity + 1 });
                    }}
                    disabled={!item.specialOrder && item.availableStock != null && item.quantity >= item.availableStock}
                    aria-label={`One more ${item.bookTitle}`}
                    className="w-6 h-6 rounded-sm bg-gray-200 dark:bg-gray-700 text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >+</button>
                  {item.availableStock != null && !item.specialOrder && (
                    <span className="text-[10px] text-gray-400 ml-1">/{item.availableStock} avail</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <select aria-label={`Discount type for ${item.bookTitle}`} value={item.discountType} onChange={(e) => setLine(item.bookId, { discountType: e.target.value as OrderLine['discountType'] })}
                    className="text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                    {(['Normal', 'Merchant', 'Special'] as const).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={() => setLine(item.bookId, { discountMode: item.discountMode === 'Percentage' ? 'Amount' : 'Percentage', discount: '0' })}
                    aria-label={`Discount as ${item.discountMode === 'Percentage' ? 'an amount' : 'a percentage'}`}
                    className="text-xs px-1.5 py-0.5 rounded-sm bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono">
                    {item.discountMode === 'Percentage' ? '%' : '$'}
                  </button>
                  <input type="number" min="0" step="0.01" value={item.discount} aria-label={`Discount on ${item.bookTitle}`}
                    onChange={(e) => setLine(item.bookId, { discount: e.target.value })}
                    className="w-14 text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300" />
                </div>
                <span className="text-sm font-medium text-gray-900 dark:text-white w-20 text-right">
                  {currency} {lineTotal(item).toFixed()}
                </span>
                <button onClick={() => setLines((ls) => ls.filter((l) => l.bookId !== item.bookId))} className="text-gray-400 hover:text-red-500 text-sm">×</button>
              </div>
              {/* Short of stock, the copies can be ordered for the customer (#174). */}
              {(item.specialOrder || (item.availableStock != null && item.quantity >= item.availableStock)) && (
                <label className="flex items-center gap-1.5 px-2 -mt-1 text-xs text-amber-700 dark:text-amber-400">
                  <input type="checkbox" aria-label={`Special order: ${item.bookTitle}`} checked={!!item.specialOrder}
                    onChange={(e) => setSpecial(item.bookId, e.target.checked)} />
                  Special order (not in stock): ordered for the customer, a credit sale
                </label>
              )}
              {item.specialOrder ? null : item.service ? (
                <div className="flex items-center gap-3 px-2 -mt-1 text-xs text-gray-700 dark:text-gray-300">
                  <span className="flex-1">
                    🧵 {item.service.name} × {item.service.quantity}
                    <span className="text-gray-400"> · {currency} {item.service.unitFee.toFixed(2)} each{item.service.discountPct > 0 ? ` · −${item.service.discountPct}%` : ''}</span>
                    <button type="button" onClick={() => setBindingFor(item.bookId)} className="ml-2 text-blue-600 dark:text-blue-400 hover:underline">Change</button>
                  </span>
                  <span className="w-20 text-right font-medium">{currency} {bindingTotal(item.service).toFixed()}</span>
                  <span className="w-3" />
                </div>
              ) : (
                <button type="button" onClick={() => setBindingFor(item.bookId)} className="px-2 -mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Binding</button>
              )}
              </Fragment>
            ))}
            <div className="flex justify-between text-sm font-semibold text-gray-900 dark:text-white pt-2 border-t border-gray-200 dark:border-gray-700">
              <span>Subtotal</span><span>{currency} {subtotal.toFixed()}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        {draftId !== null && (
          <button onClick={saveDraft} disabled={busy || lines.length === 0}
            className="flex-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-800 dark:text-gray-200 font-semibold py-3 rounded-lg transition-colors text-sm">
            Save Draft
          </button>
        )}
        <button onClick={submitOrder} disabled={busy || lines.length === 0}
          className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
          {busy ? 'Saving...' : draftId !== null ? 'Save & Confirm' : 'Create Order'}
        </button>
      </div>
      {(() => {
        const line = bindingFor === null ? undefined : lines.find((l) => l.bookId === bindingFor);
        return line && (
          <BindingDialog
            bookTitle={line.bookTitle}
            bookQuantity={line.quantity}
            value={line.service}
            maxDiscountPct={maxPct}
            onSave={(choice) => { setLine(line.bookId, { service: choice }); setBindingFor(null); }}
            onRemove={() => { setLine(line.bookId, { service: undefined }); setBindingFor(null); }}
            onClose={() => setBindingFor(null)}
          />
        );
      })()}
    </div>
  );
}
