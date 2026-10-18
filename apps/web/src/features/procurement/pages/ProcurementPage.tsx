import { useState } from 'react';
import type { PurchaseOrder } from '@bms/shared';
import { SupplierLedgerView } from '../../../pages/ProcurementLegacy.js';
import { PurchaseOrderDetail } from '../components/PurchaseOrderDetail.js';
import { EditPurchaseOrder, PurchaseOrderForm } from '../components/PurchaseOrderForm.js';
import { PurchaseOrderList } from '../components/PurchaseOrderList.js';
import { ReceiveGoodsForm } from '../components/ReceiveGoodsForm.js';
import { useRefreshPurchaseOrders } from '../queries.js';

type View = 'list' | 'detail' | 'receive' | 'form' | 'ledger';

/** Purchase orders: list, detail and steps, the order form and receiving; the ledger follows in #23's next PR. */
export default function ProcurementPage({ initialContext = {} }: { initialContext?: Record<string, string> }) {
  const refresh = useRefreshPurchaseOrders();
  const [view, setView] = useState<View>('list');
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [editing, setEditing] = useState<PurchaseOrder | undefined>(undefined);
  const [ledger, setLedger] = useState<{ id: number; name: string } | null>(null);

  const openDetail = (po: PurchaseOrder) => { setSelected(po); setView('detail'); };
  const openReceive = (po: PurchaseOrder) => { setSelected(po); setView('receive'); };
  const openForm = (po?: PurchaseOrder) => { setEditing(po); setView('form'); };
  const openLedger = (id: number, name: string) => { setLedger({ id, name }); setView('ledger'); };
  const backToList = () => { setView('list'); setSelected(null); void refresh(); };

  if (view === 'form') {
    return editing
      ? <EditPurchaseOrder id={editing.id} onSaved={openDetail} onCancel={backToList} />
      : <PurchaseOrderForm onSaved={openDetail} onCancel={backToList} />;
  }
  if (view === 'detail' && selected) {
    return <PurchaseOrderDetail poId={selected.id} onBack={backToList} onEdit={openForm} onReceive={openReceive} onLedger={openLedger} />;
  }
  if (view === 'receive' && selected) {
    return (
      <ReceiveGoodsForm order={selected} onDone={(updated) => { setSelected(updated); setView('detail'); }} onBack={() => setView('detail')} />
    );
  }
  if (view === 'ledger' && ledger) {
    return <SupplierLedgerView supplierId={ledger.id} supplierName={ledger.name} onBack={() => setView(selected ? 'detail' : 'list')} />;
  }
  return (
    <PurchaseOrderList initialContext={initialContext} onOpen={openDetail} onCreate={() => openForm()} onEdit={openForm}
      onReceive={openReceive} onLedger={openLedger} />
  );
}
