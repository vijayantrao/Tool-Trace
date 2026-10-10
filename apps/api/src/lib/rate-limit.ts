import type { Context, MiddlewareHandler } from 'hono';
import { createClient } from 'redis';
import { clientIp } from '../middleware/db.js';
import { ApiError, errorResponse } from './errors.js';

/**
 * Fixed-window counters. In memory for a single instance, or in Redis so
 * limits hold across every API instance (and survive restarts).
 */
export interface LimiterStore {
  readonly kind: 'memory' | 'redis';
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
  close(): Promise<void>;
}

export class MemoryStore implements LimiterStore {
  readonly kind = 'memory' as const;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 50_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    return { count: e.count, resetMs: e.resetAt - now };
  }

  async close() {}
}

// Atomic in Redis: increment, start the window on the first hit, report time left.
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;

/** The two client calls we use, so the store doesn't depend on node-redis generics. */
interface MinimalRedis {
  sendCommand(args: string[]): Promise<unknown>;
  close(): Promise<unknown>;
}

export class RedisStore implements LimiterStore {
  readonly kind = 'redis' as const;
  private constructor(private readonly client: MinimalRedis) {}

  static async connect(url: string): Promise<RedisStore> {
    const client = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
    client.on('error', (err: Error) => console.warn('[rate-limit] Redis error:', err.message));
    await client.connect();
    return new RedisStore(client as unknown as MinimalRedis);
  }

  async hit(key: string, windowMs: number) {
    const [count, ttl] = (await this.client.sendCommand(['EVAL', HIT_SCRIPT, '1', `tooltrace:rl:${key}`, String(windowMs)])) as [
      number,
      number,
    ];
    return { count: Number(count), resetMs: Number(ttl) };
  }

  async close() {
    await this.client.close().catch(() => {});
  }
}

export async function createLimiterStore(redisUrl?: string): Promise<LimiterStore> {
  if (!redisUrl) return new MemoryStore();
  const store = await RedisStore.connect(redisUrl);
  console.log('[rate-limit] using Redis');
  return store;
}

let lastWarning = 0;

/**
 * Rate-limit middleware. If the store is unreachable it lets requests through
 * (fails open) and logs a warning: an outage of the limiter must not take the
 * whole crib offline. Sign-in remains protected by passkeys either way.
 */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowMs: number;
  store: LimiterStore;
  trustProxy: boolean;
  key?: (c: Context) => string;
}): MiddlewareHandler {
  return async (c, next) => {
    const id = opts.key?.(c) ?? (clientIp(c, opts.trustProxy) || 'unknown');
    let result: { count: number; resetMs: number };
    try {
      result = await opts.store.hit(`${opts.name}:${id}`, opts.windowMs);
    } catch (err) {
      if (Date.now() - lastWarning > 60_000) {
        lastWarning = Date.now();
        console.warn(`[rate-limit] store unavailable, allowing requests: ${(err as Error).message}`);
      }
      return next();
    }
    c.header('RateLimit-Limit', String(opts.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, opts.limit - result.count)));
    if (result.count > opts.limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(result.resetMs / 1000))));
      return errorResponse(c, new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.'));
    }
    await next();
  };
}
