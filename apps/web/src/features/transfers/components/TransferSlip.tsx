import type { Transfer } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { STATUS_LABELS } from '../rules.js';

/** The slip that goes with the books (#170, decision 5a): what was sent, and where to sign on both ends. */
export function TransferSlip({ transfer, onClose }: { transfer: Transfer; onClose: () => void }) {
  return (
    <PrintSlip title={`Transfer ${transfer.transferNumber}`} onClose={onClose}>
      <div className="space-y-1">
        <SlipRow label="From">{transfer.fromBranchName} ({transfer.fromLocationName})</SlipRow>
        <SlipRow label="To">{transfer.toBranchName}</SlipRow>
        <SlipRow label="Dispatched">{transfer.dispatchedAt ? new Date(transfer.dispatchedAt).toLocaleString() : 'Not yet'}</SlipRow>
        <SlipRow label="Status">{STATUS_LABELS[transfer.status]}</SlipRow>
      </div>
      <table className="w-full text-sm border-t border-gray-200 dark:border-gray-700">
        <thead><tr className="text-xs text-gray-500"><th className="py-1 text-left">Book</th><th className="py-1 text-left">ISBN</th><th className="py-1 text-right">Copies</th></tr></thead>
        <tbody>
          {transfer.lines.map((l) => (
            <tr key={l.id} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1">{l.bookTitle}</td><td className="py-1 text-gray-500">{l.isbn ?? ''}</td><td className="py-1 text-right">{l.quantity}</td>
            </tr>
          ))}
          <tr className="border-t border-gray-300 dark:border-gray-600 font-semibold">
            <td className="py-1" colSpan={2}>Total</td><td className="py-1 text-right">{transfer.totalQuantity}</td>
          </tr>
        </tbody>
      </table>
      {transfer.notes && <p className="text-sm text-gray-600 dark:text-gray-300">{transfer.notes}</p>}
      <div className="grid grid-cols-2 gap-6 pt-6 text-sm">
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Sent by (name, signature, date)</p></div>
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Received by (name, signature, date)</p></div>
      </div>
    </PrintSlip>
  );
}
