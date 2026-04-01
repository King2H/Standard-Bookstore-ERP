import { createApp } from '../../app.js';
import type { Express } from 'express';

let app: Express | null = null;

export function getTestApp(): Express {
  if (!app) {
    app = createApp();
  }
  return app;
}
