/**
 * Request-scoped database transactions.
 *
 * Every signed-in API request runs inside one transaction that
 *   - switches to the least-privilege role `tooltrace_app` (SET LOCAL ROLE), so
 *     PostgreSQL's row-level security policies apply to everything the route does;
 *   - records who is acting (user, role, IP), which the policies and the audit
 *     triggers read;
 *   - is READ ONLY for GET requests, so a read endpoint can never write;
 *   - rolls back if the response is an error, so a failed request leaves no
 *     half-finished changes behind.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Sql, TxSql } from '../db.js';
import { ApiError } from '../lib/errors.js';
import type { AppEnv } from '../types.js';

/** Same id as in audit_append(). Taken first by every writer, so lock order is always the same. */
export const AUDIT_LOCK_ID = 727_274_100;

export interface ActorContext {
  role: string;
  userId?: string | null;
  stationId?: string | null;
  ip?: string | null;
}

/** Applies the actor context and drops to the restricted role for the rest of the transaction. */
export async function enterAppRole(tx: TxSql, actor: ActorContext, opts: { write: boolean }) {
  if (opts.write) await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;
  await tx`
    SELECT set_config('tooltrace.role', ${actor.role}, true),
           set_config('tooltrace.user_id', ${actor.userId ?? ''}, true),
           set_config('tooltrace.station_id', ${actor.stationId ?? ''}, true),
           set_config('tooltrace.ip', ${actor.ip ?? ''}, true)`;
  await tx`SET LOCAL ROLE tooltrace_app`;
}

/** Changes who is acting mid-transaction (a station learns who badged in). */
export async function setActorUser(tx: TxSql, userId: string | null) {
  await tx`SELECT set_config('tooltrace.user_id', ${userId ?? ''}, true)`;
}

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

const ROLLBACK = Symbol('rollback');

export function requestTransaction(sql: Sql, trustProxy: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) return next(); // every data route requires sign-in and will answer 401
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    try {
      await sql.begin(write ? 'read write' : 'read only', async (tx) => {
        await enterAppRole(tx, { role: user.role, userId: user.id, ip: clientIp(c, trustProxy) }, { write });
        c.set('db', tx);
        await next();
        if (c.error || c.res.status >= 400) throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    } finally {
      c.set('db', undefined);
    }
  };
}

/** The current request's transaction. */
export function db(c: Context<AppEnv>): TxSql {
  const tx = c.get('db');
  if (!tx) throw new ApiError(500, 'no_transaction', 'Internal error');
  return tx;
}

/**
 * Records a security event that doesn't change any table (a failed sign-in,
 * for example) straight into the audit trail, in its own short transaction.
 */
export async function auditEvent(
  sql: Sql,
  e: { action: string; entityType: string; entityId?: string | null; details?: Record<string, unknown>; ip?: string },
) {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('tooltrace.ip', ${e.ip ?? ''}, true)`;
    await tx`SELECT audit_append(${e.action}, ${e.entityType}, ${e.entityId ?? null}, ${tx.json((e.details ?? {}) as never)})`;
  });
}
