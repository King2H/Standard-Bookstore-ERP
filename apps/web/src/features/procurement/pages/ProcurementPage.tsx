import { useState } from 'react';
import type { PurchaseOrder } from '@bms/shared';
import { PurchaseOrderDetail } from '../components/PurchaseOrderDetail.js';
import { EditPurchaseOrder, PurchaseOrderForm } from '../components/PurchaseOrderForm.js';
import { PurchaseOrderList } from '../components/PurchaseOrderList.js';
import { ReceiveGoodsForm } from '../components/ReceiveGoodsForm.js';
import { SupplierLedger } from '../components/SupplierLedger.js';
import { usePurchaseOrder, useRefreshPurchaseOrders } from '../queries.js';
import { ReturnDetail } from '../../supplierReturns/components/ReturnDetail.js';
import { ReturnForm } from '../../supplierReturns/components/ReturnForm.js';
import { ReturnsList } from '../../supplierReturns/components/ReturnsList.js';
import type { SupplierReturnDetail } from '@bms/shared';
import { useMyProfile } from '../../account/queries.js';
import { SpecialOrdersTab } from '../../specialOrders/components/SpecialOrdersTab.js';
import { canBuy } from '../rules.js';

type View = 'list' | 'detail' | 'receive' | 'form' | 'ledger' | 'returns' | 'return' | 'returnForm' | 'special';

/** A draft's form needs its order; the order is read first (#173). */
function EditReturn({ draft, onDone, onCancel }: { draft: SupplierReturnDetail; onDone: (id: number) => void; onCancel: () => void }) {
  const { data: po } = usePurchaseOrder(draft.poId);
  if (!po) return <div className="p-8 text-center text-gray-400">Loading...</div>;
  return <ReturnForm po={po} draft={draft} onDone={onDone} onCancel={onCancel} />;
}

/**
 * Purchase orders: list, detail and steps, the order form, receiving, payments
 * and the supplier ledger; returns to supplier, which a link opens (#173).
 */
export default function ProcurementPage({ initialContext = {} }: { initialContext?: Record<string, string> }) {
  const refresh = useRefreshPurchaseOrders();
  const { data: me } = useMyProfile();
  const linkedReturn = Number(initialContext.returnId) || null;
  const [view, setView] = useState<View>(linkedReturn ? 'return' : 'list');
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [poId, setPoId] = useState<string | null>(null);
  const [returnId, setReturnId] = useState<number | null>(linkedReturn);
  const [returning, setReturning] = useState<{ po: PurchaseOrder | null; draft: SupplierReturnDetail | null } | null>(null);
  const [editing, setEditing] = useState<PurchaseOrder | undefined>(undefined);
  const [ledger, setLedger] = useState<{ id: number; name: string } | null>(null);

  const openDetail = (po: PurchaseOrder) => { setSelected(po); setPoId(po.id); setView('detail'); };
  const openOrder = (id: string) => { setPoId(id); setView('detail'); };
  const openReturn = (id: number) => { setReturnId(id); setView('return'); };
  const listsSwitch = (
    <div className="px-6 pt-4 flex gap-2" role="group" aria-label="Procurement lists">
      {([['list', 'Purchase Orders'], ['returns', 'Returns to Supplier'], ...(canBuy(me) ? [['special', 'Special Orders'] as const] : [])] as const).map(([v, label]) => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
          className={`px-3 py-1.5 text-sm rounded-lg ${view === v ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>{label}</button>
      ))}
    </div>
  );
  const openReceive = (po: PurchaseOrder) => { setSelected(po); setView('receive'); };
  const openForm = (po?: PurchaseOrder) => { setEditing(po); setView('form'); };
  const openLedger = (id: number, name: string) => { setLedger({ id, name }); setView('ledger'); };
  const backToList = () => { setView('list'); setSelected(null); setPoId(null); void refresh(); };

  if (view === 'form') {
    return editing
      ? <EditPurchaseOrder id={editing.id} onSaved={openDetail} onCancel={backToList} />
      : <PurchaseOrderForm onSaved={openDetail} onCancel={backToList} />;
  }
  if (view === 'detail' && poId) {
    return <PurchaseOrderDetail poId={poId} onBack={backToList} onEdit={openForm} onReceive={openReceive} onLedger={openLedger}
      onReturn={(po) => { setReturning({ po, draft: null }); setView('returnForm'); }} onOpenReturn={openReturn} />;
  }
  if (view === 'returnForm' && returning) {
    const done = (id: number) => { setReturning(null); openReturn(id); };
    const back = () => { setReturning(null); setView(returning.draft ? 'return' : 'detail'); };
    return returning.po
      ? <ReturnForm po={returning.po} draft={returning.draft} onDone={done} onCancel={back} />
      : <EditReturn draft={returning.draft!} onDone={done} onCancel={back} />;
  }
  if (view === 'return' && returnId !== null) {
    return <ReturnDetail id={returnId} onBack={() => setView('returns')} onOpenOrder={openOrder}
      onEdit={(draft) => { setReturning({ po: null, draft }); setView('returnForm'); }} />;
  }
  // Customers' special orders still to buy (#174), for the roles that buy.
  if (view === 'special' && canBuy(me)) {
    return <>{listsSwitch}<SpecialOrdersTab onOpenOrder={openOrder} /></>;
  }
  if (view === 'returns') {
    return <>{listsSwitch}<div className="p-6"><ReturnsList onOpen={openReturn} /></div></>;
  }
  if (view === 'receive' && selected) {
    return (
      <ReceiveGoodsForm order={selected} onDone={(updated) => { setSelected(updated); setPoId(updated.id); setView('detail'); }} onBack={() => setView('detail')} />
    );
  }
  if (view === 'ledger' && ledger) {
    return <SupplierLedger supplierId={ledger.id} supplierName={ledger.name} onBack={() => setView(poId ? 'detail' : 'list')} />;
  }
  return (
    <>
      {listsSwitch}
      <PurchaseOrderList initialContext={initialContext} onOpen={openDetail} onCreate={() => openForm()} onEdit={openForm}
        onReceive={openReceive} onLedger={openLedger} />
    </>
  );
}
