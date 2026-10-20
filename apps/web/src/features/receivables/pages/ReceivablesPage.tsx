import { useMyProfile } from '../../account/queries.js';
import { ReceivableList } from '../components/ReceivableList.js';
import { SummaryCards } from '../components/SummaryCards.js';
import { canSeeSummary } from '../rules.js';

/**
 * Receivables: what customers owe the branch. The totals are for the roles
 * that read reports; the Dashboard opens the list on a status.
 */
export default function ReceivablesPage({ initialContext = {}, onNavigate }: {
  initialContext?: Record<string, string>;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const { data: me } = useMyProfile();
  return (
    <div className="p-6 space-y-5">
      {canSeeSummary(me) && <SummaryCards branchId={me?.currentBranchId ?? null} />}
      <ReceivableList initialStatus={initialContext.status} onNavigate={onNavigate} />
    </div>
  );
}
