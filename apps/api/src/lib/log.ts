import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import pino from 'pino';
import { currentWork } from '../db/tenantContext.js';

/**
 * The API's log (#32, owner decision 1a): one JSON line per event on standard
 * output, which Docker keeps in rotating files (deploy/compose.yaml). A line
 * written while serving a request carries its request ID, staff, branch and
 * shop; one written by a background job carries the shop it works for.
 * Secrets and customer contacts are blanked before writing. LOG_LEVEL sets
 * the level (info by default; the tests write nothing unless asked).
 */

const requests = new AsyncLocalStorage<Request>();

/** Runs the rest of a request with it as the context of every log line. */
export function withRequestContext(req: Request, next: () => void): void {
  requests.run(req, next);
}

/** Keys blanked wherever they are, up to two levels deep. */
const SECRET_KEYS = [
  'password', 'currentPassword', 'newPassword', 'token', 'accessToken', 'refreshToken', 'secret', 'key', 'passphrase',
  'authorization', 'cookie', 'phone', 'email',
];
const REDACT = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

/** Where lines go: standard output, or a test's capture. */
let sink: (line: string) => void = (line) => { process.stdout.write(line); };

// The tests write nothing unless they capture it (Vitest sets VITEST; a developer's .env may say development).
const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'silent' : 'info');

export const log = pino(
  {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT, censor: '[redacted]' },
    mixin() {
      const req = requests.getStore();
      const work = currentWork();
      const tenantId = work && 'tenantId' in work ? work.tenantId : req?.scope?.tenantId;
      return {
        ...(req ? { requestId: req.requestId, staffId: req.staff?.staffId ?? null, branchId: req.staff?.branchId ?? null } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      };
    },
  },
  { write: (line: string) => sink(line) },
);

/** Tests: collects the lines written from now on, at every level, until the returned stop is called. */
export function captureLogs(): () => Array<Record<string, unknown>> {
  const lines: string[] = [];
  const before = { sink, level: log.level };
  sink = (line) => { lines.push(line); };
  log.level = 'trace';
  return () => {
    sink = before.sink;
    log.level = before.level;
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };
}
