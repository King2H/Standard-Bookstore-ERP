import type { ImportReport, ImportRequest, ImportResult } from '@bms/shared';
import { api, downloadFile } from '../../lib/api.js';

/** The lists a shop brings in from files (#246), by their API path. */
export type ImportKind = 'catalog' | 'opening-stock' | 'customers' | 'customer-balances' | 'supplier-balances';

export const checkFile = (kind: ImportKind, body: ImportRequest) => api.post<ImportReport>(`/imports/${kind}/check`, body);
export const importFile = (kind: ImportKind, body: ImportRequest) => api.post<ImportResult>(`/imports/${kind}`, body);
export const downloadTemplate = (kind: ImportKind) => downloadFile(`/imports/${kind}/template`, `${kind}-template.csv`);
export const downloadExport = (kind: ImportKind) => downloadFile(`/exports/${kind}`, `${kind}-${new Date().toISOString().slice(0, 10)}.csv`);
