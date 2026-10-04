import { Router, type Request, type Response, type NextFunction } from 'express';

// 2026-10-04, when /api/v1 became the canonical prefix (RFC 9745 date format).
const DEPRECATED_SINCE = '@1791072000';

/**
 * Serves the unversioned /api paths as an alias of /api/v1 during the move to a
 * versioned API (ADR-0004). Responses carry `Deprecation` and a `Link` to the
 * successor URL, so clients can see they should switch. Remove the alias once
 * the web app and integrations use /api/v1 (before v2.0.0).
 */
export function deprecatedAlias(fromPrefix: string, toPrefix: string, target: Router): Router {
  const versioned = toPrefix.slice(fromPrefix.length); // "/v1"
  const alias = Router();
  alias.use((req: Request, res: Response, next: NextFunction): void => {
    // An /api/v1/... request that matched no route ends up here too. It is not
    // an alias call, so leave this router and let the app's 404 handler answer.
    if (req.path === versioned || req.path.startsWith(`${versioned}/`)) {
      next('router');
      return;
    }
    res.setHeader('Deprecation', DEPRECATED_SINCE);
    res.setHeader('Link', `<${toPrefix}${req.url}>; rel="successor-version"`);
    next();
  });
  alias.use(target);
  return alias;
}
