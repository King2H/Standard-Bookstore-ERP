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
import { deprecatedAlias } from './middleware/deprecatedAlias.js';
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
  // Every route is served under /api/v1 (ADR-0004). The unversioned /api
  // paths stay as a deprecated alias until the web app moves to /api/v1 (M6).
  const api = express.Router();
  api.use(healthRouter);
  api.use(authRouter);
  api.use(branchRouter);
  api.use(configRouter);
  // Bank Accounts is off unless explicitly enabled. Interim switch until
  // per-tenant feature flags replace it (#27).
  if (process.env.FEATURE_BANK_ACCOUNTS === 'true') {
    api.use(bankAccountRouter);
  }
  api.use(locationRouter);
  api.use(catalogRouter);
  api.use(inventoryRouter);
  api.use(supplierRouter);
  api.use(procurementRouter);
  api.use(customerRouter);
  api.use(posRouter);
  api.use(returnsRouter);
  api.use(ordersRouter);
  api.use(paymentsRouter);
  api.use(exchangesRouter);
  api.use(financialTransactionsRouter);
  api.use(reportsRouter);
  api.use(installmentsRouter);
  api.use('/notifications', notificationsRouter);
  api.use(receivablesRouter);
  api.use(auditLogsRouter);

  app.use('/api/v1', api);
  app.use('/api', deprecatedAlias('/api', '/api/v1', api));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Route not found',
      details: {},
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Error handler (must be last) ─────────────────────────────────────
  app.use(errorHandler);

  return app;
}
