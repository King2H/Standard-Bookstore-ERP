import { useState } from 'react';
import { useMyProfile } from '../../account/queries.js';
import { useBusinessDay, useBusinessDays, useCloseDay, useDayPreview, useReopenDay } from '../queries.js';
import { canCloseDay, canReopen, daysOf, PERIOD_STATUS_LABELS, weekdayOf } from '../rules.js';
import { DayReportSlip, DayReportView } from './DayReport.js';
import { CloseDialog, ReopenDialog } from './dialogs.js';

const SECONDARY = 'px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300';
const BUTTON = 'px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50';
const CELL: Record<string, string> = {
  open: 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200',
  closed: 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-300',
  reopened: 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The session branch's days of a month (#175, decisions 1a–3a): each day
 * closed, reopened or open, in the shop's local calendar. Days still to come
 * cannot be opened.
 */
export function DaysTab({ today, month, onMonth, selected, onSelect }: {
  today: string; month: string; onMonth: (m: string) => void; selected: string | null; onSelect: (d: string | null) => void;
}) {
  const { data } = useBusinessDays(month);
  const status = new Map((data?.items ?? []).map((d) => [d.day, d.status]));
  const dates = daysOf(month);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label htmlFor="day-close-month" className="text-sm text-gray-600 dark:text-gray-300">Month</label>
        <input id="day-close-month" type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && onMonth(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
      </div>
      <div className="grid grid-cols-7 gap-1.5 max-w-2xl">
        {WEEKDAYS.map((w) => <div key={w} className="text-xs text-center text-gray-400">{w}</div>)}
        {Array.from({ length: weekdayOf(dates[0]) }, (_, i) => <div key={`pad-${i}`} />)}
        {dates.map((d) => {
          const s = status.get(d) ?? 'open';
          const later = d > today;
          const label = later ? 'Not yet' : PERIOD_STATUS_LABELS[s];
          return (
            <button key={d} type="button" disabled={later} aria-label={`${d} ${label}`} aria-pressed={selected === d} onClick={() => onSelect(d)}
              className={`rounded-lg border p-2 text-left text-xs disabled:opacity-40 ${CELL[s]} ${selected === d ? 'ring-2 ring-blue-500' : ''}`}>
              <span className="block text-sm font-semibold">{Number(d.slice(8))}</span>
              <span>{label}{d === today ? ' · today' : ''}</span>
            </button>
          );
        })}
      </div>
      {selected && <DayPanel day={selected} />}
    </div>
  );
}

function DayPanel({ day }: { day: string }) {
  const { data: me } = useMyProfile();
  const { data: preview } = useDayPreview(day);
  const { data: kept } = useBusinessDay(preview?.businessDayId ?? null);
  const close = useCloseDay();
  const reopen = useReopenDay();
  const [dialog, setDialog] = useState<'close' | 'reopen' | 'print' | null>(null);
  const headingId = `day-panel-${day}`;

  return (
    <section aria-labelledby={headingId} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-base font-semibold text-gray-900 dark:text-white">Day {day}</h2>
        {preview && <span className="text-sm text-gray-500">{PERIOD_STATUS_LABELS[preview.status]}</span>}
        {preview && (
          <div className="ml-auto flex gap-2">
            {preview.status === 'closed' && kept && <button type="button" className={SECONDARY} onClick={() => setDialog('print')}>🖨 Print day report</button>}
            {preview.status === 'closed' && kept && canReopen(me) && <button type="button" className={BUTTON} onClick={() => setDialog('reopen')}>Reopen</button>}
            {preview.status !== 'closed' && canCloseDay(me) && (
              <button type="button" className={BUTTON} disabled={preview.openCashSessions.length > 0 || preview.monthClosed} onClick={() => setDialog('close')}>Close day</button>
            )}
          </div>
        )}
      </div>
      {!preview && <p className="text-sm text-gray-400">Loading…</p>}
      {kept && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {kept.dayNumber} · closed by {kept.closedByName}, {new Date(kept.closedAt).toLocaleString()}
          {kept.reopenedAt && <> · reopened by {kept.reopenedByName}: {kept.reopenReason}</>}
        </p>
      )}
      {preview && preview.status !== 'closed' && preview.openCashSessions.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Close every cash session of the day first: {preview.openCashSessions.map((s) => s.staffName).join(', ')}
        </p>
      )}
      {preview?.monthClosed && preview.status !== 'closed' && (
        <p className="text-sm text-amber-700 dark:text-amber-400">Its month is closed; an Admin reopens the month first.</p>
      )}
      {preview && <DayReportView report={preview.report} />}
      {preview && preview.status !== 'closed' && <p className="text-xs text-gray-400">Figures so far; they are kept as they stand when the day is closed.</p>}

      {dialog === 'close' && (
        <CloseDialog what={day} label="Close day" onClose={() => setDialog(null)} onConfirm={() => close.mutateAsync(day)}
          explanation="Its report is kept, numbered DAY-, and nothing more can be recorded in this branch on that day. Corrections are then new documents on an open day; only an Admin can reopen it." />
      )}
      {dialog === 'reopen' && kept && (
        <ReopenDialog what={day} onClose={() => setDialog(null)} onConfirm={(reason) => reopen.mutateAsync({ id: kept.id, reason })} />
      )}
      {dialog === 'print' && kept && <DayReportSlip day={kept} onClose={() => setDialog(null)} />}
    </section>
  );
}
