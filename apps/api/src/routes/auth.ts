import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Sql } from '../db.js';
import { hashToken } from '../lib/crypto.js';
import { AUDIT_LOCK_ID, auditEvent, clientIp } from '../middleware/db.js';
import { ApiError, badRequest, conflict } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import { validate } from '../lib/validate.js';
import {
  challengeCookieName,
  clearSessionCookie,
  createSession,
  currentUser,
  requireAuth,
  sessionCookieName,
} from '../middleware/session.js';
import type { AppEnv, Deps, Role } from '../types.js';

const CHALLENGE_TTL_SECONDS = 300;
const WEBAUTHN_TIMEOUT_MS = 120_000;

const authFailedError = () => new ApiError(401, 'authentication_failed', 'Passkey sign-in failed');

const b64url = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/);

const registrationResponse = z.looseObject({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: b64url, attestationObject: b64url }),
  clientExtensionResults: z.looseObject({}).default({}),
});

const authenticationResponse = z.looseObject({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
  clientExtensionResults: z.looseObject({}).default({}),
});

interface ChallengeRow {
  challenge: string;
  purpose: 'register' | 'login';
  inviteId: string | null;
  webauthnUserId: Buffer | null;
  expired: boolean;
}

async function storeChallenge(
  c: Context,
  sql: Sql,
  config: Config,
  values: { challenge: string; purpose: 'register' | 'login'; inviteId?: string; webauthnUserId?: Buffer },
) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO webauthn_challenges (challenge, purpose, invite_id, webauthn_user_id, expires_at)
    VALUES (${values.challenge}, ${values.purpose}, ${values.inviteId ?? null},
            ${values.webauthnUserId ?? null}, now() + make_interval(secs => ${CHALLENGE_TTL_SECONDS}))
    RETURNING id`;
  setCookie(c, challengeCookieName(config), row!.id, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'Strict',
    path: '/',
    maxAge: CHALLENGE_TTL_SECONDS,
  });
}

/** Challenges are single-use: deleted the moment they're read, so a captured response can't be replayed. */
async function consumeChallenge(c: Context, sql: Sql, config: Config, purpose: 'register' | 'login') {
  const id = getCookie(c, challengeCookieName(config));
  deleteCookie(c, challengeCookieName(config), { path: '/', secure: config.COOKIE_SECURE });
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw badRequest('challenge_missing', 'Start the passkey flow again');
  const [row] = await sql<ChallengeRow[]>`
    DELETE FROM webauthn_challenges
    WHERE id = ${id} AND purpose = ${purpose}
    RETURNING challenge, purpose, invite_id, webauthn_user_id, expires_at < now() AS expired`;
  if (!row || row.expired) throw badRequest('challenge_expired', 'Start the passkey flow again');
  return row;
}

export function authRoutes({ sql, config, limiter }: Deps) {
  const app = new Hono<AppEnv>();
  const expectedOrigin = config.RP_ORIGINS;
  const expectedRPID = config.RP_ID;

  app.use(
    '*',
    rateLimit({
      name: 'auth',
      limit: config.AUTH_RATE_LIMIT_PER_MINUTE,
      windowMs: 60_000,
      store: limiter,
      trustProxy: config.TRUST_PROXY,
    }),
  );

  // --- Registration (only via invite) --------------------------------------
  app.post('/register/options', validate('json', z.object({ inviteToken: z.string().min(20).max(100) })), async (c) => {
    const { inviteToken } = c.req.valid('json');
    const [invite] = await sql<{ id: string; email: string }[]>`
      SELECT id, email FROM invites
      WHERE token_hash = ${hashToken(inviteToken)} AND used_at IS NULL AND expires_at > now()`;
    if (!invite) throw badRequest('invalid_invite', 'This invite link is invalid, used, or expired');

    const webauthnUserId = randomBytes(32);
    const options = await generateRegistrationOptions({
      rpName: config.RP_NAME,
      rpID: config.RP_ID,
      userName: invite.email,
      userDisplayName: invite.email,
      userID: webauthnUserId,
      attestationType: 'none',
      timeout: WEBAUTHN_TIMEOUT_MS,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await storeChallenge(c, sql, config, {
      challenge: options.challenge,
      purpose: 'register',
      inviteId: invite.id,
      webauthnUserId,
    });
    return c.json(options);
  });

  app.post(
    '/register/verify',
    validate('json', z.object({ displayName: z.string().trim().min(1).max(80), response: registrationResponse })),
    async (c) => {
      const body = c.req.valid('json');
      const challenge = await consumeChallenge(c, sql, config, 'register');

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin,
          expectedRPID,
          requireUserVerification: true,
        });
      } catch {
        throw new ApiError(400, 'registration_failed', 'Passkey could not be verified');
      }
      if (!verification.verified) throw new ApiError(400, 'registration_failed', 'Passkey could not be verified');
      const info = verification.registrationInfo;

      const user = await sql.begin(async (tx) => {
        // Same lock order as every other writer (see middleware/db.ts), so no deadlocks with the audit trail.
        await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;
        await tx`SELECT set_config('tooltrace.ip', ${clientIp(c, config.TRUST_PROXY)}, true)`;
        // Atomic claim: only one request can ever use an invite.
        const [invite] = await tx<{ email: string; role: Role }[]>`
          UPDATE invites SET used_at = now()
          WHERE id = ${challenge.inviteId} AND used_at IS NULL AND expires_at > now()
          RETURNING email, role`;
        if (!invite) throw badRequest('invalid_invite', 'This invite link is invalid, used, or expired');

        const [existing] = await tx`SELECT 1 FROM users WHERE email = ${invite.email}`;
        if (existing) throw conflict('account_exists', 'An account with this email already exists');

        const [created] = await tx<{ id: string; email: string; displayName: string; role: Role }[]>`
          INSERT INTO users (email, display_name, role, webauthn_user_id)
          VALUES (${invite.email}, ${body.displayName}, ${invite.role}, ${challenge.webauthnUserId})
          RETURNING id, email, display_name, role`;

        await tx`
          INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up)
          VALUES (${info.credential.id}, ${created!.id}, ${Buffer.from(info.credential.publicKey)},
                  ${info.credential.counter}, ${info.credential.transports ?? []},
                  ${info.credentialDeviceType}, ${info.credentialBackedUp})`;

        await createSession(tx, config, c, created!.id);
        return created!;
      });

      return c.json({ user }, 201);
    },
  );

  // --- Sign-in (discoverable passkeys, no username needed) ------------------
  app.post('/login/options', async (c) => {
    const options = await generateAuthenticationOptions({
      rpID: config.RP_ID,
      userVerification: 'required',
      timeout: WEBAUTHN_TIMEOUT_MS,
    });
    await storeChallenge(c, sql, config, { challenge: options.challenge, purpose: 'login' });
    return c.json(options);
  });

  app.post('/login/verify', validate('json', z.object({ response: authenticationResponse })), async (c) => {
    const { response } = c.req.valid('json');
    // Every failed sign-in is recorded in the audit trail, with the reason (never shown to the client).
    const authFailed = (reason: string, userId?: string) => {
      void auditEvent(sql, {
        action: 'auth.sign_in_failed',
        entityType: 'user',
        entityId: userId ?? null,
        details: { reason, credentialId: response.id.slice(0, 64) },
        ip: clientIp(c, config.TRUST_PROXY),
      }).catch((err) => console.error('[audit] could not record failed sign-in', err));
      return authFailedError();
    };
    const challenge = await consumeChallenge(c, sql, config, 'login');

    const [cred] = await sql<
      {
        id: string;
        publicKey: Buffer;
        counter: string;
        transports: string[];
        userId: string;
        webauthnUserId: Buffer;
        isActive: boolean;
      }[]
    >`
      SELECT p.id, p.public_key, p.counter, p.transports, u.id AS user_id, u.webauthn_user_id, u.is_active
      FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.id = ${response.id}`;
    // Same error for every failure, so attackers can't probe which credentials exist.
    if (!cred) throw authFailed('unknown_credential');
    if (!cred.isActive) throw authFailed('account_deactivated', cred.userId);
    if (
      response.response.userHandle &&
      response.response.userHandle !== isoBase64URL.fromBuffer(new Uint8Array(cred.webauthnUserId))
    ) {
      throw authFailed('user_handle_mismatch', cred.userId);
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID,
        requireUserVerification: true,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.publicKey),
          counter: Number(cred.counter),
          transports: cred.transports,
        },
      });
    } catch {
      throw authFailed('signature_invalid', cred.userId);
    }
    if (!verification.verified) throw authFailed('signature_invalid', cred.userId);

    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;
      await tx`SELECT set_config('tooltrace.ip', ${clientIp(c, config.TRUST_PROXY)}, true)`;
      await tx`
        UPDATE passkeys SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
        WHERE id = ${cred.id}`;
      await createSession(tx, config, c, cred.userId);
    });

    const [user] = await sql`SELECT id, email, display_name, role FROM users WHERE id = ${cred.userId}`;
    return c.json({ user });
  });

  // --- Session --------------------------------------------------------------
  app.post('/logout', async (c) => {
    const token = getCookie(c, sessionCookieName(config));
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    clearSessionCookie(c, config);
    return c.body(null, 204);
  });

  app.get('/me', requireAuth, (c) => c.json({ user: currentUser(c) }));

  return app;
}
