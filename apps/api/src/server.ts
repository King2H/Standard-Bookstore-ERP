import 'dotenv/config';
import { createApp } from './app.js';
import { checkDbConnection } from './db/index.js';
import { ensureSeedData } from './db/seed.js';
import { startOutboxPoller, stopOutboxPoller } from './workers/outboxPoller.js';
import { startInstallmentChecker, stopInstallmentChecker } from './workers/installmentChecker.js';
import { markOverdueReceivables } from './modules/receivables/receivables.service.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  // Verify DB connection before accepting traffic
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    console.error(JSON.stringify({ level: 'error', msg: 'Cannot connect to database on startup' }));
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
  startInstallmentChecker();

  // ── Overdue receivables job — runs daily at midnight ──────────────────────────
  // Marks Pending/PartiallyPaid receivables as Overdue when their due_date has passed.
  const runOverdueJob = async () => {
    try {
      const count = await markOverdueReceivables();
      if (count > 0) {
        console.log(JSON.stringify({ level: 'info', msg: 'Marked overdue receivables', count }));
      }
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
    stopInstallmentChecker();
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
