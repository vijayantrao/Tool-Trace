import type { MiddlewareHandler } from 'hono';
import { ApiError, errorResponse } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense, layered on top of SameSite=Strict cookies:
 * state-changing requests must come from an allowed origin and must not be
 * flagged by the browser as cross-site.
 */
export function originGuard(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const fetchSite = c.req.header('sec-fetch-site');
      if ((origin && !allowed.has(origin)) || fetchSite === 'cross-site') {
        return errorResponse(c, new ApiError(403, 'bad_origin', 'Cross-site request blocked'));
      }
    }
    await next();
  };
}
