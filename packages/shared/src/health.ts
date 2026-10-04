import { z } from 'zod';

/** GET /api/v1/health: 200 when the database answers, 503 when it doesn't. */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'error']),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
