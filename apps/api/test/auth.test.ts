import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite } from '../src/services/invites.js';
import { SoftAuthenticator } from './helpers/authenticator.js';
import { createHarness, ORIGIN, RP_ID, signIn, signUp, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('passkey registration via invite', () => {
  it('creates the account, stores the passkey, and signs the user in', async () => {
    const { client, user } = await signUp(h, 'storekeeper', 'Asha Verma');
    expect(user.role).toBe('storekeeper');

    const me = await client.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: user.id, role: 'storekeeper', displayName: 'Asha Verma' });

    const [passkey] = await h.sql`SELECT user_id, counter FROM passkeys WHERE user_id = ${user.id}`;
    expect(passkey).toBeDefined();
  });

  it('stores only a hash of the session token, never the token itself', async () => {
    const { client, user } = await signUp(h, 'technician');
    const token = client.cookies.get('tt_session')!;
    const rows = await h.sql`SELECT token_hash FROM sessions WHERE user_id = ${user.id}`;
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.tokenHash).toString('base64url')).not.toBe(token);
    expect(Buffer.from(rows[0]!.tokenHash)).toHaveLength(32);
  });

  it('refuses to reuse an invite', async () => {
    const { invite } = await signUp(h, 'technician');
    const res = await h.client().post('/api/auth/register/options', { inviteToken: invite.token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_invite');
  });

  it('refuses an expired invite', async () => {
    const invite = await createInvite(h.sql, h.config, { email: 'late@example.com', role: 'technician', createdBy: null });
    await h.sql`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = ${invite.id}`;
    const res = await h.client().post('/api/auth/register/options', { inviteToken: invite.token });
    expect(res.status).toBe(400);
  });

  it('rejects a passkey created for a different website (phishing protection)', async () => {
    const invite = await createInvite(h.sql, h.config, { email: 'phish@example.com', role: 'technician', createdBy: null });
    const client = h.client();
    const opts = await client.post('/api/auth/register/options', { inviteToken: invite.token });
    const response = new SoftAuthenticator(RP_ID, ORIGIN).create(opts.body, { origin: 'https://evil.example' });
    const res = await client.post('/api/auth/register/verify', { displayName: 'X', response });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('registration_failed');
    const users = await h.sql`SELECT 1 FROM users WHERE email = 'phish@example.com'`;
    expect(users).toHaveLength(0);
  });
});

describe('passkey sign-in', () => {
  it('signs back in after logout and advances the signature counter', async () => {
    const { client, authenticator, user } = await signUp(h, 'technician');
    expect((await client.post('/api/auth/logout')).status).toBe(204);
    expect((await client.get('/api/auth/me')).status).toBe(401);

    const res = await signIn(client, authenticator);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect((await client.get('/api/auth/me')).status).toBe(200);

    const [pk] = await h.sql`SELECT counter FROM passkeys WHERE user_id = ${user.id}`;
    expect(Number(pk!.counter)).toBe(1);
  });

  it('rejects a replayed sign-in response (challenges are single-use)', async () => {
    const { authenticator } = await signUp(h, 'technician');
    const client = h.client();
    const opts = await client.post('/api/auth/login/options');
    const response = authenticator.get(opts.body);
    const savedCookies = new Map(client.cookies);

    expect((await client.post('/api/auth/login/verify', { response })).status).toBe(200);

    // Attacker replays the exact same signed response with the old challenge cookie.
    const attacker = h.client();
    attacker.cookies = savedCookies;
    attacker.cookies.delete('tt_session');
    const replay = await attacker.post('/api/auth/login/verify', { response });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('challenge_expired');
  });

  it('rejects a signature made for another origin', async () => {
    const { authenticator } = await signUp(h, 'technician');
    const client = h.client();
    const opts = await client.post('/api/auth/login/options');
    const res = await client.post('/api/auth/login/verify', {
      response: authenticator.get(opts.body, { origin: 'https://evil.example' }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('authentication_failed');
  });

  it('requires user verification (fingerprint, face or PIN)', async () => {
    const { authenticator } = await signUp(h, 'technician');
    const client = h.client();
    const opts = await client.post('/api/auth/login/options');
    const res = await client.post('/api/auth/login/verify', {
      response: authenticator.get(opts.body, { userVerified: false }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown passkey with the same generic error', async () => {
    const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
    stranger.create({
      challenge: 'AAAA',
      rp: { name: 'x', id: RP_ID },
      user: { id: 'dXNlcg', name: 'u', displayName: 'u' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    });
    const client = h.client();
    const opts = await client.post('/api/auth/login/options');
    const res = await client.post('/api/auth/login/verify', { response: stranger.get(opts.body) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('authentication_failed');
  });

  it('blocks deactivated users and revokes their live sessions immediately', async () => {
    const admin = await signUp(h, 'admin');
    const tech = await signUp(h, 'technician');
    expect((await tech.client.get('/api/auth/me')).status).toBe(200);

    const off = await admin.client.patch(`/api/users/${tech.user.id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect((await tech.client.get('/api/auth/me')).status).toBe(401);
    expect((await signIn(h.client(), tech.authenticator)).status).toBe(401);
  });
});

describe('session cookie hardening', () => {
  it('uses a __Host- prefixed, HttpOnly, Secure, SameSite=Strict cookie in production mode', async () => {
    const secure = await createHarness({ COOKIE_SECURE: 'true' });
    try {
      const invite = await createInvite(secure.sql, secure.config, {
        email: 'cookie@example.com',
        role: 'technician',
        createdBy: null,
      });
      const client = secure.client();
      const opts = await client.post('/api/auth/register/options', { inviteToken: invite.token });
      const res = await client.post('/api/auth/register/verify', {
        displayName: 'Cookie Test',
        response: new SoftAuthenticator(RP_ID, ORIGIN).create(opts.body),
      });
      expect(res.status).toBe(201);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tt_session='))!;
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).not.toMatch(/Domain=/i);
    } finally {
      await secure.close();
    }
  });
});

describe('rate limiting', () => {
  it('throttles repeated sign-in attempts', async () => {
    const limited = await createHarness({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const client = limited.client();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await client.post('/api/auth/login/options')).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});
