import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { ApiError, errorResponse } from './errors.js';

/**
 * Fixed-window in-memory rate limiter for the authentication endpoints.
 * Single-instance only; Phase 4 replaces it with a Redis-backed limiter
 * so limits hold across multiple API instances.
 */
export function rateLimit(opts: { limit: number; windowMs: number; trustProxy: boolean }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const now = Date.now();
    let ip = 'unknown';
    if (opts.trustProxy) {
      ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || ip;
    } else {
      try {
        ip = getConnInfo(c).remote.address ?? ip;
      } catch {
        // Not running under the Node server (e.g. in tests).
      }
    }

    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(ip, entry);
    }
    entry.count++;

    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }

    c.header('RateLimit-Limit', String(opts.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, opts.limit - entry.count)));
    if (entry.count > opts.limit) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return errorResponse(c, new ApiError(429, 'rate_limited', 'Too many attempts. Try again shortly.'));
    }
    await next();
  };
}
