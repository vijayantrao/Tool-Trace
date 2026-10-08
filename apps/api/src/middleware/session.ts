import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import type { Sql, TxSql } from '../db.js';
import { hashToken, newToken } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { AppEnv, Role, SessionUser } from '../types.js';

/** "__Host-" cookies must be Secure, Path=/ and host-only, so they can't be set by subdomains. */
export const sessionCookieName = (config: Config) =>
  config.COOKIE_SECURE ? '__Host-tt_session' : 'tt_session';

export const challengeCookieName = (config: Config) =>
  config.COOKIE_SECURE ? '__Host-tt_webauthn' : 'tt_webauthn';

export async function createSession(
  tx: Sql | TxSql,
  config: Config,
  c: Context,
  userId: string,
): Promise<void> {
  const token = newToken();
  await tx`
    INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
    VALUES (
      ${hashToken(token)}, ${userId},
      now() + make_interval(hours => ${config.SESSION_TTL_HOURS}),
      ${c.req.header('user-agent')?.slice(0, 300) ?? null}
    )`;
  setCookie(c, sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'Strict',
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 3600,
  });
}

export function clearSessionCookie(c: Context, config: Config) {
  deleteCookie(c, sessionCookieName(config), { path: '/', secure: config.COOKIE_SECURE });
}

/** Loads the signed-in user (if any) and slides the session expiry forward. */
export function loadSession(sql: Sql, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', undefined);
    c.set('sessionId', undefined);
    const token = getCookie(c, sessionCookieName(config));
    if (token && token.length <= 100) {
      const [row] = await sql<(SessionUser & { sessionId: string; refresh: boolean })[]>`
        SELECT s.id AS session_id, u.id, u.email, u.display_name, u.role,
               s.expires_at < now() + make_interval(secs => ${config.SESSION_TTL_HOURS * 1800}) AS refresh
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${hashToken(token)}
          AND s.expires_at > now()
          AND u.is_active`;
      if (row) {
        const { sessionId, refresh, ...user } = row;
        c.set('user', user);
        c.set('sessionId', sessionId);
        if (refresh) {
          await sql`
            UPDATE sessions
            SET expires_at = now() + make_interval(hours => ${config.SESSION_TTL_HOURS}), last_seen_at = now()
            WHERE id = ${sessionId}`;
        }
      }
    }
    await next();
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const user = c.get('user');
    if (!user) throw unauthorized();
    if (!roles.includes(user.role)) throw forbidden();
    await next();
  };

/** For handlers that already passed requireAuth. */
export const currentUser = (c: Context<AppEnv>): SessionUser => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
};
