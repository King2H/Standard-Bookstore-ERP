import { useEffect, useRef, useState } from 'react';

/** A row's "⋯" menu; it opens upwards when there is no room below. */
export function RowMenu({ items }: { items: { label: string; icon: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function handleOpen() {
    if (!open && btnRef.current) {
      // Detect if there's enough space below; if not, open upward
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUp(spaceBelow < 160); // 160px ≈ 4 menu items
    }
    setOpen(o => !o);
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" ref={btnRef} onClick={handleOpen} aria-haspopup="menu" aria-expanded={open}
        className="px-2 py-1 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-sm transition-colors opacity-40 group-hover:opacity-100"
        title="Actions">
        ⋯
      </button>
      {open && (
        <div role="menu" className={`absolute right-0 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-30 py-1 ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {items.map((item, i) => (
            <button key={i} type="button" role="menuitem" onClick={() => { item.onClick(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${item.danger ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
              <span className="text-base leading-none">{item.icon}</span>{item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
