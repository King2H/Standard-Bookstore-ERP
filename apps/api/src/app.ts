import express from 'express';
import cookieParser from 'cookie-parser';
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
import reportsRouter from './modules/reports/reports.routes.js';

export function createApp() {
  const app = express();

  // â”€â”€ Core middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(loggerMiddleware);

  // â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use('/api', healthRouter);
  app.use('/api', authRouter);
  app.use('/api', branchRouter);
  app.use('/api', configRouter);
  app.use('/api', bankAccountRouter);
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
  app.use('/api', reportsRouter);
  app.use('/api', auditLogsRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  // â”€â”€ Error handler (must be last) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use(errorHandler);

  return app;
}
