import type { ReactNode } from 'react';

// Only the slip is printed, not the screen behind it (owner decision 1a, #23),
// as the POS terminal prints only its receipt.
const SLIP_PRINT_CSS = `@media print {
  body * { visibility: hidden; }
  #print-slip, #print-slip * { visibility: visible; }
  #print-slip { position: absolute; left: 0; top: 0; width: 100%; max-width: 160mm; box-shadow: none; border: 0; }
  #print-slip .no-print { display: none; }
}`;

/** A document slip (an order, an exchange) shown over the page, with Print and Close. */
export function PrintSlip({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <style>{SLIP_PRINT_CSS}</style>
      <div id="print-slip" role="dialog" aria-labelledby="print-slip-title" onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-900 text-gray-900 dark:text-white rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto p-6 space-y-4">
        <h2 id="print-slip-title" className="text-lg font-bold">{title}</h2>
        {children}
        <div className="no-print flex gap-2 pt-2">
          <button type="button" onClick={() => window.print()}
            className="flex-1 py-2 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">🖨 Print</button>
          <button type="button" onClick={onClose}
            className="flex-1 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Close</button>
        </div>
      </div>
    </div>
  );
}

/** One label–value line of a slip. */
export function SlipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
