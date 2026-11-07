import { z } from 'zod';

/** GET /api/v1/health: 200 when the database answers, 503 when it doesn't. */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'error']),
  timestamp: z.string(),
  /** The bookstore's version: the root package.json's, built into the API (#245). */
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** GET /api/v1/health/live (#32): 200 while the process answers; the database is not asked. */
export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

/** GET /api/v1/health/ready (#32): 200 when the database answers and the API is not shutting down, else 503. */
export const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  database: z.enum(['ok', 'error']),
  shuttingDown: z.boolean(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
