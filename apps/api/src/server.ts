import 'dotenv/config';
import { createApp } from './app.js';
import { checkDbConnection } from './db/index.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  // Verify DB connection before accepting traffic
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    console.error(JSON.stringify({ level: 'error', msg: 'Cannot connect to database on startup' }));
    process.exit(1);
  }

  console.log(JSON.stringify({ level: 'info', msg: 'Database connection verified' }));

  const app = createApp();

  app.listen(PORT, () => {
    console.log(
      JSON.stringify({ level: 'info', msg: `API server started`, port: PORT, env: process.env.NODE_ENV }),
    );
  });
}

start().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'Fatal startup error', error: err.message }));
  process.exit(1);
});
