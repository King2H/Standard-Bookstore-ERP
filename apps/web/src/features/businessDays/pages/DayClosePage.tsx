import { useEffect, useState } from 'react';
import { useBusinessDay, useBusinessMonth, useBusinessToday } from '../queries.js';
import { DaysTab } from '../components/DaysTab.js';
import { MonthsTab } from '../components/MonthsTab.js';

type Tab = 'days' | 'months';

/**
 * Day Close (#175, decisions 1a–6a), under Finance: the session branch's days
 * and the shop's months. The reopen notifications open a day (`dayId`) or a
 * month (`monthId`) here.
 */
export default function DayClosePage({ initialContext = {} }: { initialContext?: Record<string, string> }) {
  const { data: today } = useBusinessToday();
  const [tab, setTab] = useState<Tab>(initialContext.monthId || initialContext.tab === 'months' ? 'months' : 'days');
  const [month, setMonth] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const { data: keptDay } = useBusinessDay(initialContext.dayId ? Number(initialContext.dayId) : null);
  const { data: keptMonth } = useBusinessMonth(initialContext.monthId ? Number(initialContext.monthId) : null);

  // A notification opens its day or month once it is read.
  useEffect(() => {
    if (keptDay) { setMonth(keptDay.day.slice(0, 7)); setDay(keptDay.day); }
  }, [keptDay]);
  useEffect(() => {
    if (keptMonth) { setYear(Number(keptMonth.month.slice(0, 4))); setSelectedMonth(keptMonth.month); }
  }, [keptMonth]);

  if (!today) return <p className="p-6 text-sm text-gray-400">Loading…</p>;
  const shownMonth = month ?? today.day.slice(0, 7);
  const shownYear = year ?? Number(today.day.slice(0, 4));

  const tabClass = (t: Tab) => `px-4 py-2 text-sm font-medium border-b-2 ${tab === t
    ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`;

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <div>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Day Close</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Close the branch's day once its cash sessions are counted, and the shop's month once every branch has closed its days. Today is {today.day}.
        </p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        <button type="button" role="tab" aria-selected={tab === 'days'} className={tabClass('days')} onClick={() => setTab('days')}>Days</button>
        <button type="button" role="tab" aria-selected={tab === 'months'} className={tabClass('months')} onClick={() => setTab('months')}>Months</button>
      </div>
      {tab === 'days' ? (
        <DaysTab today={today.day} month={shownMonth} onMonth={(m) => { setMonth(m); setDay(null); }} selected={day} onSelect={setDay} />
      ) : (
        <MonthsTab year={shownYear} onYear={(y) => { setYear(y); setSelectedMonth(null); }} selected={selectedMonth} onSelect={setSelectedMonth}
          onOpenDay={(d) => { setTab('days'); setMonth(d.slice(0, 7)); setDay(d); }} />
      )}
    </div>
  );
}
