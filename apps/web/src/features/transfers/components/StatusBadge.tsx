import type { TransferStatus } from '@bms/shared';
import { STATUS_CLASSES, STATUS_LABELS } from '../rules.js';

export function StatusBadge({ status }: { status: TransferStatus }) {
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASSES[status]}`}>{STATUS_LABELS[status]}</span>;
}
