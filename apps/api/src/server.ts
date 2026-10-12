import 'dotenv/config';
import { createApp } from './app.js';
import { assertEnvironment } from './lib/env.js';
import { appRoleProblem, checkDbConnection } from './db/index.js';
import { ensureSeedData } from './db/seed.js';
import { forEachTenant } from './db/tenants.js';
import { startOutboxPoller, stopOutboxPoller } from './workers/outboxPoller.js';
import { markOverdueReceivables } from './modules/receivables/receivables.service.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  assertEnvironment();

  // Verify DB connection before accepting traffic
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    console.error(JSON.stringify({ level: 'error', msg: 'Cannot connect to database on startup' }));
    process.exit(1);
  }

  const roleProblem = await appRoleProblem();
  if (roleProblem) {
    console.error(JSON.stringify({
      level: 'error',
      msg: `Refusing to start: ${roleProblem}, so tenants would not be kept apart. DATABASE_URL must name the API's own user (npm run db:app-role); migrations use MIGRATION_DATABASE_URL.`,
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({ level: 'info', msg: 'Database connection verified' }));

  // Ensure minimum seed data exists (idempotent — safe to run every startup)
  await ensureSeedData();

  const app = createApp();

  const server = app.listen(PORT, () => {
    console.log(
      JSON.stringify({ level: 'info', msg: `API server started`, port: PORT, env: process.env.NODE_ENV }),
    );
  });

  // Start background workers
  startOutboxPoller();

  // ── Overdue receivables job — runs daily at midnight ──────────────────────────
  // Marks Pending/PartiallyPaid receivables as Overdue when their due_date has passed.
  const runOverdueJob = async () => {
    try {
      await forEachTenant('Overdue receivables job', async (tenantId) => {
        const count = await markOverdueReceivables();
        if (count > 0) {
          console.log(JSON.stringify({ level: 'info', msg: 'Marked overdue receivables', tenantId, count }));
        }
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'Overdue receivables job failed', error: (err as Error).message }));
    }
  };

  // Run once on startup, then every 24 hours
  runOverdueJob();
  const overdueJobInterval = setInterval(runOverdueJob, 24 * 60 * 60 * 1000);

  // Graceful shutdown
  const shutdown = () => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...' }));
    stopOutboxPoller();
    clearInterval(overdueJobInterval);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'Fatal startup error', error: err.message }));
  process.exit(1);
});
