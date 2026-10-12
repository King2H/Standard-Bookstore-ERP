import type { Supplier } from '@bms/shared';
import { StatusBadge } from '../../../components/StatusFilter.js';
import type { SupplierAction } from '../api.js';

const ACTION = 'px-2 py-1 rounded-sm transition-colors';

/** The suppliers on one page, with the actions the user may take on each. */
export function SupplierTable({ suppliers, canWrite, canModerate, onEdit, onAction, onDelete }: {
  suppliers: Supplier[];
  canWrite: boolean;
  /** Blacklist and delete. */
  canModerate: boolean;
  onEdit: (s: Supplier) => void;
  onAction: (s: Supplier, action: SupplierAction) => void;
  onDelete: (s: Supplier) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"><tr>{['Name', 'Type', 'Lead Time', 'Contact', 'Status', 'Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
        {suppliers.map(s => {
          const contact = s.contactInfo as { email?: string; phone?: string };
          return (
            <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{s.name}{s.isBlacklisted && <span className="ml-2 text-xs bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 px-1.5 py-0.5 rounded-sm">Blacklisted</span>}</td>
              <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.supplierType === 'publisher' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'}`}>{s.supplierType === 'publisher' ? `Publisher${s.publisherName ? ` - ${s.publisherName}` : ''}` : 'External'}</span></td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{s.leadTimeDays}d</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">{contact.email && <div>{contact.email}</div>}{contact.phone && <div>{contact.phone}</div>}</td>
              <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
              <td className="px-4 py-3"><div className="flex items-center gap-1 text-xs flex-wrap">
                {canWrite && <button onClick={() => onEdit(s)} className={`${ACTION} text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950`}>Edit</button>}
                {canWrite && (
                  s.status === 'ACTIVE'
                    ? <button onClick={() => onAction(s, 'deactivate')} className={`${ACTION} text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950`}>Deactivate</button>
                    : <button onClick={() => onAction(s, 'activate')} className={`${ACTION} text-green-600 hover:bg-green-50 dark:hover:bg-green-950`}>Activate</button>
                )}
                {canWrite && (
                  s.status === 'ARCHIVED'
                    ? <button onClick={() => onAction(s, 'restore')} className={`${ACTION} text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950`}>Restore</button>
                    : <button onClick={() => onAction(s, 'archive')} className={`${ACTION} text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950`}>Archive</button>
                )}
                {canModerate && !s.isBlacklisted && <button onClick={() => onAction(s, 'blacklist')} className={`${ACTION} text-red-600 hover:bg-red-50 dark:hover:bg-red-950`}>Blacklist</button>}
                {canModerate && <button onClick={() => onDelete(s)} className={`${ACTION} text-red-600 hover:bg-red-50 dark:hover:bg-red-950`}>Delete</button>}
              </div></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
