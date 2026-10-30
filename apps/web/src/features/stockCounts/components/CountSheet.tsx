import type { StockCountDetail } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';

/** A sheet to count on paper (#172, decision 2a): the books and a blank column, nothing expected. */
export function CountSheet({ count, onClose }: { count: StockCountDetail; onClose: () => void }) {
  return (
    <PrintSlip title={`Count sheet ${count.countNumber}`} onClose={onClose}>
      <div className="space-y-1">
        <SlipRow label="Location">{count.locationName}</SlipRow>
        <SlipRow label="Opened">{new Date(count.createdAt).toLocaleString()}</SlipRow>
      </div>
      <table className="w-full text-sm border-t border-gray-200 dark:border-gray-700">
        <thead><tr className="text-xs text-gray-500"><th className="py-1 text-left">Book</th><th className="py-1 text-left">ISBN</th><th className="py-1 text-right w-24">Counted</th></tr></thead>
        <tbody>
          {count.lines.map((l) => (
            <tr key={l.id} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1.5">{l.bookTitle}</td><td className="py-1.5 text-gray-500">{l.isbn ?? ''}</td><td className="py-1.5 border-b border-gray-400" />
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pt-6 text-sm"><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Counted by (name, signature, date)</p></div>
    </PrintSlip>
  );
}
