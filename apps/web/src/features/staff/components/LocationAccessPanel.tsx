import { useState } from 'react';
import type { Location } from '@bms/shared';
import { useLocationsOfBranches, useStaffLocations } from '../queries.js';

/**
 * A staff member's location access, shown below their row. Locations of a
 * branch the signed-in staff member cannot change are shown as they are and
 * sent back unchanged, as the API requires.
 */
export function LocationAccessPanel({ staffId, staffUsername, branchIds, canChangeIn, onSave, onClose, isSaving }: {
  staffId: number;
  staffUsername: string;
  /** The branches the staff member holds roles in. */
  branchIds: number[];
  canChangeIn: (branchId: number) => boolean;
  onSave: (locationIds: number[]) => void;
  onClose: () => void;
  isSaving: boolean;
}) {
  const assignments = useStaffLocations(staffId);
  const locations = useLocationsOfBranches(branchIds);

  if (!assignments.data || locations.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 py-1">
        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading location access...
      </div>
    );
  }

  return (
    <AccessEditor
      staffUsername={staffUsername}
      locations={locations.items}
      assigned={assignments.data.items.map(a => a.locationId)}
      canChangeIn={canChangeIn}
      onSave={onSave}
      onClose={onClose}
      isSaving={isSaving}
    />
  );
}

function AccessEditor({ staffUsername, locations, assigned, canChangeIn, onSave, onClose, isSaving }: {
  staffUsername: string;
  locations: Location[];
  assigned: number[];
  canChangeIn: (branchId: number) => boolean;
  onSave: (locationIds: number[]) => void;
  onClose: () => void;
  isSaving: boolean;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(assigned));
  const changeable = (loc: Location) => canChangeIn(loc.branchId);

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Clears only what is the signed-in staff member's to change.
  const clearAll = () => setSelected(new Set(assigned.filter(id => {
    const loc = locations.find(l => l.id === id);
    return loc !== undefined && !changeable(loc);
  })));

  const isFallback = selected.size === 0;

  return (
    <div className="space-y-3 py-1">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
            📍 Location Access — <span className="font-mono">{staffUsername}</span>
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {isFallback
              ? 'No restrictions — staff can access all locations in their branch'
              : `Restricted to ${selected.size} specific location(s)`}
          </p>
        </div>
        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
          isFallback
            ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
            : 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400'
        }`}>
          {isFallback ? '✓ Full Access' : '⚠ Restricted'}
        </span>
      </div>

      {locations.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 italic">
          No locations exist for this staff member's branches yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {locations.map(loc => {
            const isChecked = selected.has(loc.id);
            const mine = changeable(loc);
            return (
              <button
                key={loc.id}
                type="button"
                aria-pressed={isChecked}
                onClick={() => toggle(loc.id)}
                disabled={!mine}
                title={mine ? undefined : 'Not yours to change: changed from its own branch'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  isChecked
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-xs'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-400 dark:hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400'
                }`}
              >
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                  isChecked ? 'bg-white border-white' : 'border-current'
                }`}>
                  {isChecked && (
                    <svg className="w-2.5 h-2.5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                {loc.name}
                {loc.isDefaultFulfillment && (
                  <span className={`text-xs ${isChecked ? 'text-indigo-200' : 'text-green-500'}`}>★</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Select specific locations to restrict access. Deselect all to restore full branch access. ★ = default fulfillment.
      </p>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onSave(Array.from(selected))}
          disabled={isSaving}
          className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg font-medium disabled:opacity-50 transition-colors"
        >
          {isSaving ? 'Saving...' : 'Save Access'}
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          title="Clear all — restore full branch access"
        >
          Clear all
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors ml-auto"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
