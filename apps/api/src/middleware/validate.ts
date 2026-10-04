import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';
import { ValidationError } from '../lib/errors.js';

/** Schemas for the parts of a request a route accepts (ADR-0004). */
export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/** The parsed request parts, typed from the schemas. */
export type ValidRequest<S extends RequestSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

const PARTS = ['params', 'query', 'body'] as const;

/**
 * Validates the request against shared zod schemas before the controller runs.
 * On failure it responds 400 VALIDATION_ERROR with every issue, each path
 * prefixed by the request part ("body", "query" or "params"). On success the
 * parsed values (with defaults and coercions applied) are available through
 * `valid(req, schemas)`; the raw req.query and req.params are left untouched.
 */
export function validate<S extends RequestSchemas>(schemas: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed: Partial<Record<(typeof PARTS)[number], unknown>> = {};
    const issues: z.core.$ZodIssue[] = [];

    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        parsed[part] = result.data;
      } else {
        issues.push(...result.error.issues.map((issue) => ({ ...issue, path: [part, ...issue.path] })));
      }
    }

    if (issues.length > 0) {
      next(new ValidationError('Invalid request', { issues }));
      return;
    }
    req.valid = parsed;
    next();
  };
}

/** The values validate(schemas) parsed for this request, typed from the same schemas. */
export function valid<S extends RequestSchemas>(req: Request, _schemas: S): ValidRequest<S> {
  if (!req.valid) throw new Error('valid() called on a route without validate()');
  return req.valid as ValidRequest<S>;
}
