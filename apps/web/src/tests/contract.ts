import type { z } from 'zod';

/**
 * A mocked API answer, checked against its @bms/shared contract: a fixture
 * that drifts from what the API sends fails the test that uses it, instead
 * of testing the page against data the API never returns.
 */
export function contract<T extends z.ZodType>(schema: T, data: z.input<T>): z.output<T> {
  return schema.parse(data);
}
