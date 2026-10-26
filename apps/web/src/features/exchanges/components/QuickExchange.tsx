import { Fragment, useEffect, useState } from 'react';
import { Money, type Customer } from '@bms/shared';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import PaymentProofFields from '../../../components/PaymentProofFields.js';
import { useToast } from '../../../components/Toast.js';
import { getCurrentBranchId } from '../../../lib/api.js';
import { PAYMENT_METHOD_META, type PaymentMethodCode } from '../../../lib/paymentMethods.js';
import { EMPTY_PROOF, proofError, proofFields, type PaymentProof } from '../../../lib/paymentProof.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import { useLocations } from '../../locations/queries.js';
import { AMOUNT_MESSAGE, isAmount } from '../../pos/sale.js';
import { bindingTotal, fitTo } from '../../services/binding.js';
import { BindingDialog } from '../../services/components/BindingDialog.js';
import { useBooksForExchange, useCreateExchange, useCustomersForExchange } from '../queries.js';
import { exchangeTotals, tradeInProblem, type IncomingLine, type OutgoingLine } from '../rules.js';
import { QuickRegisterDialog } from './QuickRegisterDialog.js';

// How the customer pays what they owe at the counter (owner decision 2a).
type PayMethod = Extract<PaymentMethodCode, 'cash' | 'bank' | 'mobile' | 'store_credit' | 'loyalty_points'>;
const PAY_METHODS: PayMethod[] = ['cash', 'bank', 'mobile', 'store_credit', 'loyalty_points'];

type CustomerPick = Pick<Customer, 'id' | 'customerCode' | 'fullName'>;
type BookPick = { id: number; title: string; defaultPrice: number | null; branchPrice?: number | null };

/** The shop's price for a book, or null when it has none yet. */
const sellingPriceOf = (b: BookPick) => {
  const price = b.branchPrice ?? b.defaultPrice;
  return price === null || price === undefined ? null : Money.of(price);
};

/**
 * Books brought in for books taken out, at the counter. The difference is
 * settled now: the customer pays it (or leaves the rest on credit), or the
 * store gives it back as store credit or cash.
 */
export function QuickExchange({ onDone }: { onDone: () => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const branchId = getCurrentBranchId();

  const [locationId, setLocationId] = useState<number | ''>('');
  const [bookSearch, setBookSearch] = useState('');
  const [incomingItems, setIncomingItems] = useState<IncomingLine[]>([]);
  const [outgoingItems, setOutgoingItems] = useState<OutgoingLine[]>([]);
  const [addingTo, setAddingTo] = useState<'incoming' | 'outgoing'>('incoming');
  const [payMethod, setPayMethod] = useState<PayMethod>('cash');
  const [payBankAccountId, setPayBankAccountId] = useState<number | null>(null);
  const [payProof, setPayProof] = useState<PaymentProof>(EMPTY_PROOF);
  const [payAmount, setPayAmount] = useState('');
  const [allowCredit, setAllowCredit] = useState(false);
  const [refundMethod, setRefundMethod] = useState<'store_credit' | 'cash'>('store_credit');
  const [registering, setRegistering] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerPick | null>(null);
  const [bindingFor, setBindingFor] = useState<number | null>(null);

  // With Bank Accounts on, a bank payment names the account it went to (#21).
  const { accounts: bankAccounts, required: bankAccountRequired } = useBranchBankAccounts(branchId, payMethod === 'bank');
  const { data: locData } = useLocations(branchId);
  const { data: bookResults } = useBooksForExchange(bookSearch, locationId || null);
  const { data: customerResults } = useCustomersForExchange(customerSearch);
  const createExchange = useCreateExchange();

  // The branch's default location (or its first) until staff pick another,
  // so book search shows stock at once.
  useEffect(() => {
    if (locationId !== '' || !locData?.items?.length) return;
    const def = locData.items.find((l) => l.isDefaultFulfillment) ?? locData.items[0];
    if (def) setLocationId(def.id);
  }, [locData, locationId]);

  function addBook(book: BookPick) {
    const sellingPrice = sellingPriceOf(book);
    const bump = <T extends { bookId: number; quantity: number }>(items: T[]) =>
      items.map((i) => (i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
    if (addingTo === 'incoming') {
      setIncomingItems((items) => items.some((i) => i.bookId === book.id) ? bump(items) : [...items, {
        bookId: book.id, bookTitle: book.title, quantity: 1, allowance: String(sellingPrice?.toNumber() ?? 0), sellingPrice, condition: 'resellable',
      }]);
    } else {
      setOutgoingItems((items) => items.some((i) => i.bookId === book.id) ? bump(items) : [...items, {
        bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: sellingPrice ?? Money.ZERO,
      }]);
    }
    setBookSearch('');
  }

  const { incomingTotal, outgoingTotal, net } = exchangeTotals(incomingItems, outgoingItems);
  const customerPays = net.greaterThan(0);
  const storeRefunds = net.lessThan(0);
  const settlementType = customerPays ? 'Customer Pays' : storeRefunds ? 'Store Refunds' : 'Even';

  function reset() {
    setIncomingItems([]); setOutgoingItems([]); setBookSearch('');
    setSelectedCustomer(null); setCustomerSearch('');
    setPayAmount(''); setPayProof(EMPTY_PROOF); setAllowCredit(false); setRefundMethod('store_credit');
  }

  /** An outgoing line's copies; its binding is kept to them (#169 PR 4). */
  function setOutgoingQuantity(bookId: number, quantity: number) {
    setOutgoingItems((items) => items.map((i) => i.bookId === bookId ? { ...i, quantity, binding: fitTo(i.binding, quantity) } : i));
  }

  function submitExchange() {
    if (incomingItems.length === 0 && outgoingItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    if (outgoingItems.some((o) => o.binding) && !selectedCustomer) { showToast('A binding needs a customer, who is called when it is ready', 'error'); return; }
    if (!locationId) { showToast('Select a location — every exchange moves physical stock', 'error'); return; }
    // An allowance becomes the book's cost in stock; the API holds it to the selling price.
    const tradeIn = tradeInProblem(incomingItems, me);
    if (tradeIn) { showToast(tradeIn, 'error'); return; }
    if (customerPays && payAmount.trim() !== '' && !isAmount(payAmount)) { showToast(AMOUNT_MESSAGE, 'error'); return; }
    const paid = customerPays ? (payAmount.trim() === '' ? net : Money.of(payAmount.trim())) : Money.ZERO;
    const short = paid.lessThan(net);
    if (customerPays && short && !allowCredit) {
      showToast('Take the full difference, or leave the rest on credit', 'error');
      return;
    }
    if (paid.greaterThan(0) && payMethod === 'bank' && bankAccountRequired && !payBankAccountId) {
      showToast('Select the bank account the payment went to', 'error');
      return;
    }
    const missingProof = paid.greaterThan(0) ? proofError(payMethod, payProof) : null;
    if (missingProof) { showToast(missingProof, 'error'); return; }
    if ((allowCredit && customerPays && short) || (storeRefunds && refundMethod === 'store_credit')
      || ((payMethod === 'store_credit' || payMethod === 'loyalty_points') && paid.greaterThan(0))) {
      if (!selectedCustomer) { showToast('Select a customer: credit, store credit and points belong to a customer', 'error'); return; }
    }
    createExchange.mutate({
      locationId,
      customerId: selectedCustomer?.id ?? undefined,
      incomingItems: incomingItems.map((i) => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: Money.of(i.allowance.trim()).toNumber(), condition: i.condition })),
      outgoingItems: outgoingItems.map((o) => ({
        bookId: o.bookId, quantity: o.quantity, ...(o.binding && { service: { serviceId: o.binding.serviceId, quantity: o.binding.quantity } }),
      })),
      payments: paid.greaterThan(0)
        ? [{
            method: payMethod,
            amount: paid.toNumber(),
            ...(payMethod === 'bank' && payBankAccountId ? { bankAccountId: payBankAccountId } : {}),
            ...proofFields(payMethod, payProof),
          }]
        : [],
      allowCredit: allowCredit && short,
      refundMethod,
    }, {
      onSuccess: (e) => {
        showToast(`Exchange ${e.exchangeReference} completed`, 'success');
        reset();
        onDone();
      },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const locations = locData?.items ?? [];
  const books = bookResults?.items ?? [];
  const customers = customerResults?.items ?? [];

  return (
    <div className="flex-1 overflow-auto p-4 pb-6 max-w-3xl mx-auto w-full space-y-4">
      {/* Every exchange moves stock, so it needs a location. */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Location <span className="text-red-500">*</span></h3>
        <select required aria-label="Location" value={locationId} onChange={(e) => setLocationId(Number(e.target.value) || '')}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
          <option value="">Select location...</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
        </select>
      </div>

      {/* Customer — needed for credit, store credit and loyalty points. */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Customer <span className="text-gray-400 font-normal">(needed for credit, store credit, points and bindings)</span>
        </h3>
        {selectedCustomer ? (
          <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
            <span className="text-sm text-blue-700 dark:text-blue-300">{selectedCustomer.fullName} <span className="text-xs text-blue-500">({selectedCustomer.customerCode})</span></span>
            <button onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }} className="text-gray-400 hover:text-red-500 text-sm">×</button>
          </div>
        ) : (
          <div className="relative">
            <input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Search customer by name or code..."
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
            {customers.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                {customers.map((c) => (
                  <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <span className="font-medium text-gray-900 dark:text-white">{c.fullName}</span>
                    <span className="text-gray-500 dark:text-gray-400 ml-2 text-xs">{c.customerCode}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Book search */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
        <div className="flex gap-2">
          <button onClick={() => setAddingTo('incoming')} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${addingTo === 'incoming' ? 'bg-green-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>📥 Add Incoming</button>
          <button onClick={() => setAddingTo('outgoing')} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${addingTo === 'outgoing' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>📤 Add Outgoing</button>
        </div>
        <div className="relative">
          <input value={bookSearch} onChange={(e) => setBookSearch(e.target.value)} placeholder={`Search books to add as ${addingTo}...`}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
          {books.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
              {books.map((b) => (
                <button key={b.id} onClick={() => addBook(b)} className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <p className="font-medium text-gray-900 dark:text-white truncate">{b.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{b.isbn} · {currency} {(sellingPriceOf(b) ?? Money.ZERO).toFixed()}</p>
                  {b.availability != null && (
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {b.availability.locationName && <span className="text-xs text-gray-400">📍 {b.availability.locationName}</span>}
                      <span className={`text-xs font-medium ${b.availability.available === 0 ? 'text-red-600 dark:text-red-400' : b.availability.available <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                        {b.availability.available === 0 ? '⚠ Out of stock' : `✓ ${b.availability.available} available`}
                      </span>
                      {b.availability.reserved > 0 && <span className="text-xs text-orange-500 dark:text-orange-400">🔒 {b.availability.reserved} reserved</span>}
                      <span className="text-xs text-gray-400">On hand: {b.availability.onHand}</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          {/* A book brought in that the shop never had can be registered without leaving the exchange. */}
          {addingTo === 'incoming' && bookSearch.length > 1 && books.length === 0 && (
            <button
              onClick={() => setRegistering(bookSearch)}
              className="mt-2 w-full text-left px-3 py-2 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors"
            >
              + Can't find it? Quick-register "{bookSearch}" as a new catalog entry
            </button>
          )}
        </div>
      </div>

      {/* Items */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-green-200 dark:border-green-800 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">📥 Incoming (Customer Gives)</h3>
          {incomingItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : (
            <>
              <div className="flex items-center gap-2 text-[10px] text-gray-400 uppercase tracking-wide">
                <span className="flex-1">Book</span>
                <span className="w-12 text-center">Qty</span>
                <span className="w-20 text-center">Allowance</span>
                <span className="w-24 text-center">Condition</span>
                <span className="w-4" />
              </div>
              {incomingItems.map((item) => (
                <div key={item.bookId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
                  <input type="number" min="1" aria-label={`Quantity of ${item.bookTitle} brought in`} value={item.quantity}
                    onChange={(e) => setIncomingItems((items) => items.map((i) => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))}
                    className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <input
                    type="number" min="0.01" step="0.01" value={item.allowance}
                    aria-label={`Allowance for ${item.bookTitle}`}
                    title="Customer Allowance Value — the trade-in credit granted for this book; becomes its cost basis in inventory"
                    onChange={(e) => setIncomingItems((items) => items.map((i) => i.bookId === item.bookId ? { ...i, allowance: e.target.value } : i))}
                    className={`w-20 px-1 py-0.5 border rounded-sm text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${isAmount(item.allowance) ? 'border-gray-300 dark:border-gray-600' : 'border-red-400 dark:border-red-600'}`}
                  />
                  <select aria-label={`Condition of ${item.bookTitle}`} value={item.condition}
                    onChange={(e) => setIncomingItems((items) => items.map((i) => i.bookId === item.bookId ? { ...i, condition: e.target.value as IncomingLine['condition'] } : i))}
                    className="w-24 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
                    <option value="resellable">Resellable</option>
                    <option value="damaged">Damaged</option>
                  </select>
                  <button onClick={() => setIncomingItems((items) => items.filter((i) => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                </div>
              ))}
            </>
          )}
          <div className="text-xs font-semibold text-green-700 dark:text-green-400 pt-1 border-t border-green-100 dark:border-green-900">Total: {currency} {incomingTotal.toFixed()}</div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-blue-200 dark:border-blue-800 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400">📤 Outgoing (Customer Takes)</h3>
          {outgoingItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : outgoingItems.map((item) => (
            <Fragment key={item.bookId}>
            <div className="flex items-center gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
              <input type="number" min="1" aria-label={`Quantity of ${item.bookTitle} taken`} value={item.quantity}
                onChange={(e) => setOutgoingQuantity(item.bookId, parseInt(e.target.value) || 1)}
                className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
              <span className="w-20 text-right text-gray-700 dark:text-gray-300" title="Catalog price">{currency} {item.unitPrice.toFixed()}</span>
              <button onClick={() => setOutgoingItems((items) => items.filter((i) => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
            </div>
            {/* A binding on some or all of the copies, at the branch's fee, no discount (#169 PR 4). */}
            {item.binding ? (
              <div className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 pl-2">
                <span className="flex-1">
                  🧵 {item.binding.name} × {item.binding.quantity}
                  <button type="button" onClick={() => setBindingFor(item.bookId)} className="ml-2 text-blue-600 dark:text-blue-400 hover:underline">Change</button>
                </span>
                <span className="w-20 text-right">{currency} {bindingTotal(item.binding).toFixed()}</span>
                <span className="w-3" />
              </div>
            ) : (
              <button type="button" onClick={() => setBindingFor(item.bookId)} className="pl-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Binding</button>
            )}
            </Fragment>
          ))}
          <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 pt-1 border-t border-blue-100 dark:border-blue-900">Total: {currency} {outgoingTotal.toFixed()}</div>
        </div>
      </div>

      {/* Summary */}
      {(incomingItems.length > 0 || outgoingItems.length > 0) && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
          <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Net Balance</span><span className={`font-semibold ${!customerPays && !storeRefunds ? 'text-gray-600 dark:text-gray-400' : customerPays ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`}>{currency} {net.toFixed()}</span></div>
          <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Settlement</span><span className="font-medium text-gray-900 dark:text-white">{settlementType}</span></div>
          {customerPays && (
            <div className="space-y-2 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
              <div className="flex gap-2 items-center">
                <select aria-label="Payment method" value={payMethod} onChange={(e) => setPayMethod(e.target.value as PayMethod)}
                  className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
                  {PAY_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_META[m].icon} {PAYMENT_METHOD_META[m].label}</option>)}
                </select>
                <input aria-label="Amount paid" type="number" min="0" step="0.01" value={payAmount} placeholder={net.toFixed()}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-28 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-white" />
              </div>
              {payMethod === 'bank' && bankAccountRequired && (
                <BankAccountSelect accounts={bankAccounts} value={payBankAccountId} onChange={setPayBankAccountId} />
              )}
              <PaymentProofFields method={payMethod} value={payProof} onChange={setPayProof} />
              <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <input type="checkbox" checked={allowCredit} onChange={(e) => setAllowCredit(e.target.checked)} />
                Leave what is not paid on credit (a receivable for the customer)
              </label>
            </div>
          )}
          {storeRefunds && (
            <div className="flex gap-2 items-center bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm">
              <span className="text-gray-600 dark:text-gray-400">Give back {currency} {net.abs().toFixed()} as</span>
              <select aria-label="Refund method" value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as 'store_credit' | 'cash')}
                className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
                <option value="store_credit">🎁 Store Credit</option>
                <option value="cash">💵 Cash</option>
              </select>
            </div>
          )}
          <button onClick={submitExchange} disabled={createExchange.isPending}
            className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm mt-2">
            {createExchange.isPending ? 'Processing...' : 'Complete Exchange'}
          </button>
        </div>
      )}

      {(() => {
        const line = bindingFor === null ? undefined : outgoingItems.find((o) => o.bookId === bindingFor);
        const save = (binding: OutgoingLine['binding']) => {
          setOutgoingItems((items) => items.map((i) => i.bookId === bindingFor ? { ...i, binding } : i));
          setBindingFor(null);
        };
        return line && (
          <BindingDialog bookTitle={line.bookTitle} bookQuantity={line.quantity} value={line.binding} maxDiscountPct={0} discounts={false}
            onSave={save} onRemove={() => save(undefined)} onClose={() => setBindingFor(null)} />
        );
      })()}

      {registering !== null && (
        <QuickRegisterDialog
          initialTitle={registering}
          onRegistered={(book) => { addBook(book); setRegistering(null); }}
          onCancel={() => setRegistering(null)}
        />
      )}
    </div>
  );
}
