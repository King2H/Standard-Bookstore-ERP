import 'dotenv/config';
import { createApp } from './app.js';
import { checkDbConnection } from './db/index.js';
import { ensureSeedData } from './db/seed.js';
import { startOutboxPoller, stopOutboxPoller } from './workers/outboxPoller.js';
import { startInstallmentChecker, stopInstallmentChecker } from './workers/installmentChecker.js';

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

  // Graceful shutdown
  const shutdown = () => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...' }));
    stopOutboxPoller();
    stopInstallmentChecker();
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
