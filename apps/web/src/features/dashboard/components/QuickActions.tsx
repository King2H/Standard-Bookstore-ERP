import type { ReactNode } from 'react';
import type { Page } from '../../../app/navigation.js';
import { quickActionsFor } from '../rules.js';

const LOOK: Partial<Record<Page, { icon: ReactNode; color: string }>> = {
  pos: { icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>), color: 'from-blue-500 to-blue-600' },
  procurement: { icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>), color: 'from-indigo-500 to-indigo-600' },
  customers: { icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>), color: 'from-purple-500 to-purple-600' },
  payments: { icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>), color: 'from-green-500 to-green-600' },
};

/** Shortcuts to the pages the person may open (was: all four for everyone). */
export function QuickActions({ userRole, userPermissions, onNavigate }: {
  userRole: string | null;
  userPermissions: string[];
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const actions = quickActionsFor(userRole, userPermissions);
  if (actions.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {actions.map(action => (
        <button
          key={action.page}
          onClick={() => onNavigate?.(action.page)}
          className={`group relative overflow-hidden rounded-xl bg-linear-to-br ${LOOK[action.page]?.color ?? ''} p-4 text-left text-white shadow-xs hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0`}
        >
          <div className="absolute -right-3 -top-3 w-16 h-16 rounded-full bg-white/10 group-hover:bg-white/15 transition-colors" />
          <span className="text-2xl block mb-2">{LOOK[action.page]?.icon}</span>
          <p className="text-sm font-semibold leading-tight">{action.label}</p>
          <p className="text-xs text-white/70 mt-0.5">{action.desc}</p>
        </button>
      ))}
    </div>
  );
}
