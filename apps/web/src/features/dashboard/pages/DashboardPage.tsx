import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import WelcomeBanner from '../../../components/WelcomeBanner.js';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { exportReport, type ReportParams } from '../api.js';
import { Overview } from '../components/Overview.js';
import { QuickActions } from '../components/QuickActions.js';
import { ReportSections } from '../components/ReportSections.js';
import { EMPTY_DRAFT, Toolbar, type Draft } from '../components/Toolbar.js';
import { reportKeys, useKpis } from '../queries.js';
import { canReadReports, rangeProblem } from '../rules.js';

function toParams(d: Draft): ReportParams {
  return {
    ...(d.dateFrom ? { dateFrom: d.dateFrom } : {}),
    ...(d.dateTo ? { dateTo: d.dateTo } : {}),
    groupBy: d.groupBy,
    ...(d.branchId ? { branchId: Number(d.branchId) } : {}),
  };
}

/**
 * The Dashboard: shortcuts, filters, the Live Overview and the report
 * sections. Shown to every role held that reads
 * reports; the branch is the session's unless staff with access to all
 * branches pick one.
 */
export default function DashboardPage({ userRole, userRoles, userPermissions, onNavigate }: {
  userRole: string | null;
  userRoles: string[];
  userPermissions: string[];
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const { data: me } = useMyProfile();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [refreshing, setRefreshing] = useState(false);
  const problem = rangeProblem(draft.dateFrom, draft.dateTo);
  // A range out of order is not sent: the sections keep the last one that was.
  const applied = useRef<ReportParams>(toParams(EMPTY_DRAFT));
  if (!problem) applied.current = toParams(draft);
  const params = applied.current;
  const { dataUpdatedAt: kpiUpdatedAt } = useKpis(params.branchId, canReadReports(me));

  async function refreshAll() {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: reportKeys.all });
    } finally {
      setRefreshing(false);
    }
  }

  function exportCsv(type: string) {
    exportReport(type, params).catch(() => showToast('Export failed', 'error'));
  }

  if (!me) return null;
  if (!canReadReports(me)) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <div className="mx-auto mb-3 text-gray-300 dark:text-gray-600"><svg className="w-12 h-12 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg></div>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Dashboard is available to Manager, Admin, and Finance Officer roles.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Welcome Banner — sits between the top bar and page content, outside scroll ── */}
      <WelcomeBanner />

    <div className="flex-1 overflow-y-auto">
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto pb-10">

      <QuickActions userRole={userRole} userRoles={userRoles} userPermissions={userPermissions} onNavigate={onNavigate} />

      <Toolbar draft={draft} setDraft={setDraft} problem={problem} allBranches={me.isAllBranches}
        kpiUpdatedAt={kpiUpdatedAt} refreshing={refreshing} onRefresh={refreshAll} onExport={exportCsv} />

      <Overview params={params} onNavigate={onNavigate} />

      <ReportSections params={params} onNavigate={onNavigate} />

    </div>
    </div>
    </div>
  );
}
