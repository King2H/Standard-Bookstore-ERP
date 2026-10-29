import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { requestIdMiddleware } from './middleware/requestId.js';
import { loggerMiddleware } from './middleware/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import auditLogsRouter from './modules/audit/audit.routes.js';
import authRouter from './modules/auth/auth.routes.js';
import staffRouter from './modules/staff/staff.routes.js';
import branchRouter from './modules/branch/branch.routes.js';
import configRouter from './modules/config/config.routes.js';
import bankAccountRouter from './modules/bankAccount/bankAccount.routes.js';
import locationRouter from './modules/location/location.routes.js';
import catalogRouter from './modules/catalog/catalog.routes.js';
import catalogReferenceRouter from './modules/catalogReference/catalogReference.routes.js';
import servicesRouter from './modules/services/services.routes.js';
import transfersRouter from './modules/transfers/transfers.routes.js';
import cashSessionsRouter from './modules/cashSessions/cashSessions.routes.js';
import inventoryRouter from './modules/inventory/inventory.routes.js';
import supplierRouter from './modules/supplier/supplier.routes.js';
import procurementRouter from './modules/procurement/procurement.routes.js';
import supplierPayablesRouter from './modules/procurement/supplierPayables.routes.js';
import customerRouter from './modules/customer/customer.routes.js';
import posRouter from './modules/pos/pos.routes.js';
import returnsRouter from './modules/returns/returns.routes.js';
import ordersRouter from './modules/orders/orders.routes.js';
import paymentsRouter from './modules/payments/payments.routes.js';
import exchangesRouter from './modules/exchanges/exchanges.routes.js';
import financialTransactionsRouter from './modules/financialTransactions/financialTransactions.routes.js';
import salesReportsRouter from './modules/reports/sales/sales.routes.js';
import kpiReportsRouter from './modules/reports/kpis/kpis.routes.js';
import inventoryReportsRouter from './modules/reports/inventory/inventoryReports.routes.js';
import customerReportsRouter from './modules/reports/customers/customerReports.routes.js';
import receivableReportsRouter from './modules/reports/receivables/receivableReports.routes.js';
import paymentReportsRouter from './modules/reports/payments/paymentReports.routes.js';
import exchangeReportsRouter from './modules/reports/exchanges/exchangeReports.routes.js';
import returnReportsRouter from './modules/reports/returns/returnReports.routes.js';
import procurementReportsRouter from './modules/reports/procurement/procurementReports.routes.js';
import notificationsRouter from './modules/notifications/notifications.routes.js';
import receivablesRouter from './modules/receivables/receivables.routes.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { corsMiddleware } from './middleware/cors.js';
import { unversionedApiGone } from './middleware/unversionedApi.js';
import { readHttpConfig } from './lib/env.js';
import { buildOpenApiDocument } from './openapi/document.js';

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
  app.use('/api', unversionedApiGone);
  app.use(csrfMiddleware);

  // ── Routes ────────────────────────────────────────────────────────────
  // Every route is served under /api/v1 (ADR-0004).
  const api = express.Router();
  api.get('/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  api.use(healthRouter);
  api.use(authRouter);
  // After authRouter: /staff/me must match before /staff/:id.
  api.use(staffRouter);
  api.use(branchRouter);
  api.use(configRouter);
  // Bank Accounts is off unless explicitly enabled. Interim switch until
  // per-tenant feature flags replace it (#27).
  if (process.env.FEATURE_BANK_ACCOUNTS === 'true') {
    api.use(bankAccountRouter);
  }
  api.use(locationRouter);
  api.use(catalogRouter);
  api.use(catalogReferenceRouter);
  api.use(servicesRouter);
  api.use(transfersRouter);
  api.use(cashSessionsRouter);
  api.use(inventoryRouter);
  api.use(supplierRouter);
  api.use(procurementRouter);
  api.use(supplierPayablesRouter);
  api.use(customerRouter);
  api.use(posRouter);
  api.use(returnsRouter);
  api.use(ordersRouter);
  api.use(paymentsRouter);
  api.use(exchangesRouter);
  api.use(financialTransactionsRouter);
  api.use(salesReportsRouter);
  api.use(kpiReportsRouter);
  api.use(inventoryReportsRouter);
  api.use(customerReportsRouter);
  api.use(receivableReportsRouter);
  api.use(paymentReportsRouter);
  api.use(exchangeReportsRouter);
  api.use(returnReportsRouter);
  api.use(procurementReportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use(receivablesRouter);
  api.use(auditLogsRouter);

  app.use('/api/v1', api);

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
