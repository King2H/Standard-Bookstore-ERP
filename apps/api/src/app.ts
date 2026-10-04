import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { requestIdMiddleware } from './middleware/requestId.js';
import { loggerMiddleware } from './middleware/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import auditLogsRouter from './routes/auditLogs.js';
import authRouter from './modules/auth/auth.routes.js';
import branchRouter from './modules/branch/branch.routes.js';
import configRouter from './modules/config/config.routes.js';
import bankAccountRouter from './modules/bankAccount/bankAccount.routes.js';
import locationRouter from './modules/location/location.routes.js';
import catalogRouter from './modules/catalog/catalog.routes.js';
import inventoryRouter from './modules/inventory/inventory.routes.js';
import supplierRouter from './modules/supplier/supplier.routes.js';
import procurementRouter from './modules/procurement/procurement.routes.js';
import customerRouter from './modules/customer/customer.routes.js';
import posRouter from './modules/pos/pos.routes.js';
import returnsRouter from './modules/returns/returns.routes.js';
import ordersRouter from './modules/orders/orders.routes.js';
import paymentsRouter from './modules/payments/payments.routes.js';
import exchangesRouter from './modules/exchanges/exchanges.routes.js';
import financialTransactionsRouter from './modules/financialTransactions/financialTransactions.routes.js';
import reportsRouter from './modules/reports/reports.routes.js';
import installmentsRouter from './modules/payments/installments.routes.js';
import notificationsRouter from './modules/notifications/notifications.routes.js';
import receivablesRouter from './modules/receivables/receivables.routes.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { corsMiddleware } from './middleware/cors.js';
import { readHttpConfig } from './lib/env.js';

export function createApp() {
  const app = express();

  const httpConfig = readHttpConfig();

  // Client addresses (rate limiting, logs) come from X-Forwarded-For only when
  // it was set by a proxy we trust.
  app.set('trust proxy', httpConfig.trustProxy);

  app.use(helmet());
  app.use(corsMiddleware(httpConfig));

  // ── Core middleware ──────────────────────────────────────────────────
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(loggerMiddleware);
  app.use(csrfMiddleware);

  // ── Routes ────────────────────────────────────────────────────────────
  app.use('/api', healthRouter);
  app.use('/api', authRouter);
  app.use('/api', branchRouter);
  app.use('/api', configRouter);
  // Bank Accounts is off unless explicitly enabled. Interim switch until
  // per-tenant feature flags replace it (#27).
  if (process.env.FEATURE_BANK_ACCOUNTS === 'true') {
    app.use('/api', bankAccountRouter);
  }
  app.use('/api', locationRouter);
  app.use('/api', catalogRouter);
  app.use('/api', inventoryRouter);
  app.use('/api', supplierRouter);
  app.use('/api', procurementRouter);
  app.use('/api', customerRouter);
  app.use('/api', posRouter);
  app.use('/api', returnsRouter);
  app.use('/api', ordersRouter);
  app.use('/api', paymentsRouter);
  app.use('/api', exchangesRouter);
  app.use('/api', financialTransactionsRouter);
  app.use('/api', reportsRouter);
  app.use('/api', installmentsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api', receivablesRouter);
  app.use('/api', auditLogsRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  // ── Error handler (must be last) ─────────────────────────────────────
  app.use(errorHandler);

  return app;
}
