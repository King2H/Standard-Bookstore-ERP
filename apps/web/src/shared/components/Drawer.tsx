import { useId } from 'react';

/** A panel that slides in from the right, over a dimmed page; a click outside closes it. */
export function Drawer({ title, onClose, footer, tabs, activeTab, onTabChange, children }: {
  title: string; onClose: () => void; footer?: React.ReactNode;
  tabs?: { id: string; label: string }[]; activeTab?: string; onTabChange?: (id: string) => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-[480px] bg-white dark:bg-gray-900 shadow-2xl flex flex-col h-full border-l border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <h3 id={titleId} className="font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">✕</button>
        </div>
        {tabs && tabs.length > 0 && (
          <div className="flex border-b border-gray-200 dark:border-gray-800 px-5 gap-1 shrink-0">
            {tabs.map(t => (
              <button key={t.id} type="button" onClick={() => onTabChange?.(t.id)}
                className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800 flex gap-3 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}
