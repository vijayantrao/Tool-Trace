import { Hono } from 'hono';
import { z } from 'zod';
import { hashToken } from '../lib/crypto.js';
import { ApiError, conflict, notFound } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import { validate } from '../lib/validate.js';
import { AUDIT_LOCK_ID, clientIp, db } from '../middleware/db.js';
import { currentUser, requireAuth } from '../middleware/session.js';
import { answerAcknowledgement, type AckSubject } from '../services/acknowledgements.js';
import type { AppEnv, Deps } from '../types.js';

const answerSchema = z.object({
  answer: z.enum(['received', 'not_received']),
  note: z.string().trim().max(300).optional(),
});
const tokenSchema = z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/);

interface AckRow {
  id: string;
  userId: string;
  requestedBy: string;
  summary: string;
  subjectType: AckSubject;
  subjectId: string;
  status: string;
}

export function acknowledgementRoutes({ sql, config, notifier, limiter }: Deps) {
  const app = new Hono<AppEnv>();

  /** Mine (what I still have to confirm), or for crib staff and auditors, every open or disputed one. */
  app.get(
    '/acknowledgements',
    requireAuth,
    validate('query', z.object({ scope: z.enum(['mine', 'all']).default('mine') })),
    async (c) => {
      const user = currentUser(c);
      const { scope } = c.req.valid('query');
      const all = scope === 'all' && ['admin', 'storekeeper', 'auditor'].includes(user.role);
      const tx = db(c);
      const acknowledgements = await tx`
        SELECT a.id, a.subject_type, a.subject_id, a.summary, a.status, a.created_at, a.responded_at, a.responded_via, a.note,
               a.user_id, u.display_name AS user_name, r.display_name AS requested_by_name
        FROM acknowledgements a JOIN users u ON u.id = a.user_id JOIN users r ON r.id = a.requested_by
        WHERE ${all ? tx`a.status IN ('pending', 'disputed') OR a.responded_at > now() - interval '7 days'` : tx`a.user_id = ${user.id} AND a.status = 'pending'`}
        ORDER BY a.created_at DESC LIMIT 200`;
      return c.json({ acknowledgements });
    },
  );

  app.post('/acknowledgements/:id/answer', requireAuth, validate('param', z.object({ id: z.uuid() })), validate('json', answerSchema), async (c) => {
    const user = currentUser(c);
    const tx = db(c);
    const [ack] = await tx<AckRow[]>`
      SELECT id, user_id, requested_by, summary, subject_type, subject_id, status FROM acknowledgements
      WHERE id = ${c.req.valid('param').id} AND user_id = ${user.id} FOR UPDATE`;
    if (!ack) throw notFound('Item to confirm');
    if (ack.status !== 'pending') throw conflict('already_answered', 'You have already answered this');
    const b = c.req.valid('json');
    const status = await answerAcknowledgement(tx, notifier, ack, b.answer, b.note, 'app');
    return c.json({ status });
  });

  // ---- The single-use link in the email (works without signing in) ----------
  const link = new Hono<AppEnv>();
  link.use('*', rateLimit({ name: 'ack', limit: 20, windowMs: 60_000, store: limiter, trustProxy: config.TRUST_PROXY }));
  const byToken = async (tx: typeof sql, token: string, lock = false) => {
    const [ack] = await tx<(AckRow & { userName: string; requestedByName: string; createdAt: Date })[]>`
      SELECT a.id, a.user_id, a.requested_by, a.summary, a.subject_type, a.subject_id, a.status, a.created_at,
             u.display_name AS user_name, r.display_name AS requested_by_name
      FROM acknowledgements a JOIN users u ON u.id = a.user_id JOIN users r ON r.id = a.requested_by
      WHERE a.token_hash = ${hashToken(token)} AND a.status = 'pending' ${lock ? tx`FOR UPDATE OF a` : tx``}`;
    if (!ack) throw new ApiError(404, 'link_invalid', 'This link has already been used. Open ToolTrace to see what you have.');
    return ack;
  };

  link.post('/info', validate('json', z.object({ token: tokenSchema })), async (c) => {
    const ack = await byToken(sql, c.req.valid('json').token);
    return c.json({ summary: ack.summary, issuedBy: ack.requestedByName, issuedTo: ack.userName, issuedAt: ack.createdAt });
  });

  link.post('/answer', validate('json', answerSchema.extend({ token: tokenSchema })), async (c) => {
    const b = c.req.valid('json');
    const status = await sql.begin(async (tx) => {
      // No session: runs as the owner, in the same lock order as every writer. The answer is the token holder's.
      await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;
      await tx`SELECT set_config('tooltrace.ip', ${clientIp(c, config.TRUST_PROXY)}, true)`;
      const ack = await byToken(tx as unknown as typeof sql, b.token, true);
      return answerAcknowledgement(tx, notifier, ack, b.answer, b.note, 'email');
    });
    return c.json({ status });
  });

  app.route('/ack', link);
  return app;
}
