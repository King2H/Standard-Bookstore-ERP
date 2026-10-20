import { ImportStatementRequestSchema, type ImportStatementRequest, type ProfileResponse } from '@bms/shared';

/**
 * Who may do what with bank accounts: the API's rules (bankAccount.routes.ts),
 * so the page offers only what the API accepts. Any role held in the session
 * branch counts (was: the main role).
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Opening, editing, deactivating and reactivating accounts. */
export const canManageAccounts = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);

/** Importing a statement, matching and unmatching. */
export const canReconcile = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer']);

/**
 * Statement lines pasted from the bank's export, one per line: date
 * (YYYY-MM-DD), amount, in|out, reference, description. Checked with the
 * API's rules, so one bad line is named instead of the whole import being
 * refused (was: an amount with more than two decimals or a date that does
 * not exist failed the import).
 */
export function parseStatement(text: string): { lines: ImportStatementRequest['lines'] } | { problem: string } {
  const rows = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const lines: ImportStatementRequest['lines'] = [];
  for (const [i, row] of rows.entries()) {
    const [statementDate, amount, direction, reference, ...rest] = row.split(',').map((x) => x.trim());
    const line = {
      statementDate,
      amount,
      direction,
      ...(reference ? { reference } : {}),
      ...(rest.length ? { description: rest.join(', ') } : {}),
    };
    const checked = ImportStatementRequestSchema.shape.lines.element.safeParse(line);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return { problem: `Line ${i + 1}: ${issue.path.join('.') || 'line'}: ${issue.message} ("${row}")` };
    }
    lines.push(checked.data);
  }
  const whole = ImportStatementRequestSchema.safeParse({ lines });
  if (!whole.success) return { problem: lines.length ? `At most 1000 lines in one import (${lines.length} given)` : 'Paste at least one line' };
  return { lines: whole.data.lines };
}
