import 'dotenv/config';
import { createApp } from './app.js';
import { assertEnvironment } from './lib/env.js';
import { appRoleProblem, checkDbConnection, db } from './db/index.js';
import { ensureSeedData } from './db/seed.js';
import { forEachTenant } from './db/tenants.js';
import { log } from './lib/log.js';
import { setShuttingDown } from './lib/readiness.js';
import { sseManager } from './lib/sseManager.js';
import { startOutboxPoller, stopOutboxPoller } from './workers/outboxPoller.js';
import { markOverdueReceivables } from './modules/receivables/receivables.service.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
/** Docker waits 10 s after asking the API to stop: requests in progress get most of it. */
const SHUTDOWN_GRACE_MS = 8_000;

async function start() {
  assertEnvironment();

  // Verify DB connection before accepting traffic
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    log.fatal('Cannot connect to database on startup');
    process.exit(1);
  }

  const roleProblem = await appRoleProblem();
  if (roleProblem) {
    log.fatal(`Refusing to start: ${roleProblem}, so tenants would not be kept apart. DATABASE_URL must name the API's own user (npm run db:app-role); migrations use MIGRATION_DATABASE_URL.`);
    process.exit(1);
  }

  log.info('Database connection verified');

  // Ensure minimum seed data exists (idempotent — safe to run every startup)
  await ensureSeedData();

  const app = createApp();

  const server = app.listen(PORT, () => {
    log.info({ port: PORT, env: process.env.NODE_ENV }, 'API server started');
  });

  // Start background workers
  startOutboxPoller();

  // ── Overdue receivables job — runs daily at midnight ──────────────────────────
  // Marks Pending/PartiallyPaid receivables as Overdue when their due_date has passed.
  const runOverdueJob = async () => {
    try {
      await forEachTenant('Overdue receivables job', async () => {
        const count = await markOverdueReceivables();
        if (count > 0) log.info({ count }, 'Marked overdue receivables');
      });
    } catch (err) {
      log.error({ err }, 'Overdue receivables job failed');
    }
  };

  // Run once on startup, then every 24 hours
  runOverdueJob();
  const overdueJobInterval = setInterval(runOverdueJob, 24 * 60 * 60 * 1000);

  // Graceful shutdown (#32, 3a): readiness answers 503 at once, requests in
  // progress finish, the live notification streams end, then the database.
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    setShuttingDown(true);
    log.info({ signal }, 'Shutting down');
    stopOutboxPoller();
    clearInterval(overdueJobInterval);
    sseManager.closeAll();
    server.close(() => {
      db.end().finally(() => {
        log.info('Stopped');
        process.exit(0);
      });
    });
    server.closeIdleConnections();
    setTimeout(() => {
      log.warn('Requests still in progress at the end of the grace period: stopping anyway');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
