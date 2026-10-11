/**
 * Idempotency keys: a phone that queued actions while offline can replay them
 * safely, any number of times, and each one happens exactly once.
 *
 * The client sends `Idempotency-Key: <uuid>`. Inside the request's own
 * transaction, the key row is inserted *first*:
 *
 * - New key: the action runs. If it succeeds, its response is stored in the
 *   same transaction, so "action done" and "answer remembered" commit together.
 *   If it fails, both roll back and a retry starts fresh.
 * - Seen key, same request: the stored answer is returned and nothing runs
 *   again (`Idempotent-Replayed: true`). A concurrent duplicate waits for the
 *   original to commit, then gets its answer.
 * - Seen key, different request: refused, so a key can't be reused to smuggle
 *   in a different action.
 *
 * Keys are per person and expire after 7 days (swept by the API).
 */
import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ApiError, badRequest } from '../lib/errors.js';
import type { AppEnv } from '../types.js';
import { db } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idempotency(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    const user = c.get('user');
    if (key === undefined || !user || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    if (!UUID.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be a UUID');

    const body = await c.req.text();
    const hash = createHash('sha256').update(`${c.req.method} ${c.req.path}\n`).update(body).digest();
    const sql = db(c);

    const claimed = await sql`
      INSERT INTO idempotency_keys (user_id, key, request_hash)
      VALUES (${user.id}, ${key}, ${hash})
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING 1`;
    if (claimed.length === 0) {
      const [seen] = await sql<{ requestHash: Buffer; status: number | null; responseJson: string | null }[]>`
        SELECT request_hash, status, response::text AS response_json
        FROM idempotency_keys WHERE user_id = ${user.id} AND key = ${key}`;
      if (!seen || !seen.requestHash.equals(hash)) {
        throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
      }
      if (seen.status === null) {
        throw new ApiError(409, 'idempotency_in_progress', 'The original request is still being processed');
      }
      c.header('Idempotent-Replayed', 'true');
      return c.json(seen.responseJson ? JSON.parse(seen.responseJson) : null, seen.status as 200);
    }

    await next();

    if (!c.error && c.res.status >= 200 && c.res.status < 300) {
      const text = await c.res.clone().text();
      await sql`
        UPDATE idempotency_keys SET status = ${c.res.status}, response = ${text ? sql.json(JSON.parse(text)) : null}
        WHERE user_id = ${user.id} AND key = ${key}`;
    }
  };
}
