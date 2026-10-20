/**
 * Requests and approvals: a new tool, a replacement (damaged, missing, Kaizen)
 * or more stock. A storekeeper reviews, an admin decides, the crib fulfils.
 * Nobody signs off their own request, and the approver is never the reviewer.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import type { Message } from '../services/notify.js';
import { price } from './tools.js';
import type { AppEnv, Deps, SessionUser } from '../types.js';
import type { TxSql } from '../db.js';

const idParam = z.object({ id: z.uuid() });
const note = z.string().trim().max(500).optional();

export const REASON_LABEL: Record<string, string> = {
  new_requirement: 'New requirement',
  damaged: 'Replacement against damaged',
  missing: 'Issuance against missing',
  kaizen: 'Kaizen improvement',
  used_up: 'Used up',
  other: 'Other',
};

interface RequestRow {
  id: string;
  number: number;
  kind: string;
  reason: string;
  title: string;
  quantity: number;
  status: string;
  requestedBy: string;
  reviewedBy: string | null;
  decidedBy: string | null;
}

const requestColumns = `
  r.id, r.number::int AS number, r.kind, r.reason, r.title, r.details, r.quantity, r.estimated_cost::float8 AS estimated_cost,
  r.tool_id, t.asset_tag AS tool_asset_tag, t.name AS tool_name,
  r.stock_item_id, s.code AS stock_code, s.name AS stock_name,
  r.status, r.created_at, r.updated_at,
  r.requested_by, rq.display_name AS requested_by_name,
  r.reviewed_by, rv.display_name AS reviewed_by_name, r.reviewed_at,
  r.decided_by, dc.display_name AS decided_by_name, r.decided_at,
  r.closed_by, cl.display_name AS closed_by_name, r.closed_at`;
const requestFrom = `
  requests r
  JOIN users rq ON rq.id = r.requested_by
  LEFT JOIN users rv ON rv.id = r.reviewed_by
  LEFT JOIN users dc ON dc.id = r.decided_by
  LEFT JOIN users cl ON cl.id = r.closed_by
  LEFT JOIN tools t ON t.id = r.tool_id
  LEFT JOIN stock_items s ON s.id = r.stock_item_id`;

export function requestRoutes({ notifier }: Deps) {
  const app = new Hono<AppEnv>();
  const label = (r: Pick<RequestRow, 'number' | 'title'>) => `REQ-${String(r.number).padStart(4, '0')} ${r.title}`;

  const load = async (tx: TxSql, id: string) => {
    const [r] = await tx<RequestRow[]>`
      SELECT id, number::int AS number, kind, reason, title, quantity, status, requested_by, reviewed_by, decided_by
      FROM requests WHERE id = ${id} FOR UPDATE`;
    if (!r) throw notFound('Request');
    return r;
  };
  const step = async (tx: TxSql, r: RequestRow, user: SessionUser, action: string, n?: string) => {
    await tx`INSERT INTO request_events (request_id, action, by_user, note) VALUES (${r.id}, ${action}, ${user.id}, ${n || null})`;
  };
  const tell = (tx: TxSql, to: (string | null)[], r: RequestRow, m: Omit<Message, 'link'>) =>
    notifier.send(tx, to, { ...m, link: `/requests?id=${r.id}` });

  app.get(
    '/requests',
    requireAuth,
    validate('query', z.object({ scope: z.enum(['mine', 'review', 'approve', 'all']).default('mine') })),
    async (c) => {
      const user = currentUser(c);
      const { scope } = c.req.valid('query');
      const tx = db(c);
      const where =
        scope === 'review'
          ? tx`r.status = 'submitted' AND r.requested_by <> ${user.id}`
          : scope === 'approve'
            ? tx`r.status = 'reviewed' AND r.requested_by <> ${user.id} AND r.reviewed_by <> ${user.id}`
            : scope === 'all'
              ? tx`true`
              : tx`r.requested_by = ${user.id}`;
      // Row-level security narrows "all" to the person's own requests unless they are crib staff or an auditor.
      const requests = await tx`
        SELECT ${tx.unsafe(requestColumns)} FROM ${tx.unsafe(requestFrom)}
        WHERE ${where}
        ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, r.created_at DESC
        LIMIT 300`;
      const [counts] = await tx`
        SELECT count(*) FILTER (WHERE status = 'submitted' AND requested_by <> ${user.id})::int AS to_review,
               count(*) FILTER (WHERE status = 'reviewed' AND requested_by <> ${user.id} AND reviewed_by <> ${user.id})::int AS to_approve,
               count(*) FILTER (WHERE status = 'approved')::int AS to_fulfil
        FROM requests`;
      return c.json({ requests, counts });
    },
  );

  app.get('/requests/:id', requireAuth, validate('param', idParam), async (c) => {
    const tx = db(c);
    const { id } = c.req.valid('param');
    const [request] = await tx`SELECT ${tx.unsafe(requestColumns)} FROM ${tx.unsafe(requestFrom)} WHERE r.id = ${id}`;
    if (!request) throw notFound('Request');
    const events = await tx`
      SELECT e.id::int AS id, e.action, e.note, e.at, u.display_name AS by_name
      FROM request_events e JOIN users u ON u.id = e.by_user WHERE e.request_id = ${id} ORDER BY e.id`;
    return c.json({ request, events });
  });

  app.post(
    '/requests',
    requireRole('admin', 'storekeeper', 'technician'),
    validate(
      'json',
      z
        .object({
          kind: z.enum(['new_tool', 'replacement', 'stock']),
          reason: z.enum(['new_requirement', 'damaged', 'missing', 'kaizen', 'used_up', 'other']),
          title: z.string().trim().min(1).max(120),
          details: z.string().trim().max(1000).optional(),
          quantity: z.number().int().min(1).max(100_000).default(1),
          estimatedCost: price.optional(),
          toolId: z.uuid().optional(),
          stockItemId: z.uuid().optional(),
        })
        .refine((v) => v.kind !== 'replacement' || v.toolId, { message: 'Choose the tool to replace', path: ['toolId'] }),
    ),
    async (c) => {
      const user = currentUser(c);
      const b = c.req.valid('json');
      const tx = db(c);
      const [r] = await tx<RequestRow[]>`
        INSERT INTO requests (kind, reason, title, details, quantity, estimated_cost, tool_id, stock_item_id, requested_by)
        VALUES (${b.kind}, ${b.reason}, ${b.title}, ${b.details || null}, ${b.quantity}, ${b.estimatedCost ?? null},
                ${b.toolId ?? null}, ${b.stockItemId ?? null}, ${user.id})
        RETURNING id, number::int AS number, kind, reason, title, quantity, status, requested_by, reviewed_by, decided_by`;
      await step(tx, r!, user, 'submitted', b.details);
      await tell(tx, await notifier.staff(tx, [user.id]), r!, {
        kind: 'request.submitted',
        title: `${user.displayName} asks for ${b.quantity > 1 ? `${b.quantity} × ` : ''}${b.title}`,
        body: `${REASON_LABEL[b.reason]}. Review it in ToolTrace.`,
      });
      return c.json({ request: { id: r!.id, number: r!.number, status: r!.status } }, 201);
    },
  );

  // Step 1: a storekeeper (or admin) forwards it for approval, or turns it down.
  app.post(
    '/requests/:id/review',
    requireRole('admin', 'storekeeper'),
    validate('param', idParam),
    validate('json', z.object({ action: z.enum(['forward', 'reject']), note })),
    async (c) => {
      const user = currentUser(c);
      const tx = db(c);
      const { action, note: n } = c.req.valid('json');
      const r = await load(tx, c.req.valid('param').id);
      if (r.requestedBy === user.id) throw forbidden('You cannot review your own request');
      if (r.status !== 'submitted') throw conflict('invalid_transition', `This request is already ${r.status}`);
      if (action === 'forward') {
        await tx`UPDATE requests SET status = 'reviewed', reviewed_by = ${user.id}, reviewed_at = now() WHERE id = ${r.id}`;
        await step(tx, r, user, 'reviewed', n);
        await tell(tx, await notifier.people(tx, ['admin'], [user.id, r.requestedBy]), r, {
          kind: 'request.to_approve',
          title: `Approve ${label(r)}?`,
          body: `${user.displayName} reviewed it and passed it on for approval.${n ? ` “${n}”` : ''}`,
        });
      } else {
        await tx`UPDATE requests SET status = 'rejected', reviewed_by = ${user.id}, reviewed_at = now(), decided_by = ${user.id}, decided_at = now() WHERE id = ${r.id}`;
        await step(tx, r, user, 'rejected', n);
        await tell(tx, [r.requestedBy], r, {
          kind: 'request.rejected',
          title: `${label(r)} was not approved`,
          body: n ? `${user.displayName}: “${n}”` : `Turned down by ${user.displayName}.`,
        });
      }
      return c.json({ status: action === 'forward' ? 'reviewed' : 'rejected' });
    },
  );

  // Step 2: an admin who neither asked for it nor reviewed it decides.
  app.post(
    '/requests/:id/decide',
    requireRole('admin'),
    validate('param', idParam),
    validate('json', z.object({ action: z.enum(['approve', 'reject']), note })),
    async (c) => {
      const user = currentUser(c);
      const tx = db(c);
      const { action, note: n } = c.req.valid('json');
      const r = await load(tx, c.req.valid('param').id);
      if (r.requestedBy === user.id) throw forbidden('You cannot approve your own request');
      if (r.reviewedBy === user.id) throw forbidden('Someone other than the reviewer has to approve it');
      if (r.status !== 'reviewed') throw conflict('invalid_transition', r.status === 'submitted' ? 'A storekeeper has to review it first' : `This request is already ${r.status}`);
      const status = action === 'approve' ? 'approved' : 'rejected';
      await tx`UPDATE requests SET status = ${status}, decided_by = ${user.id}, decided_at = now() WHERE id = ${r.id}`;
      await step(tx, r, user, status, n);
      await tell(tx, [r.requestedBy], r, {
        kind: `request.${status}`,
        title: action === 'approve' ? `${label(r)} is approved` : `${label(r)} was not approved`,
        body: n ? `${user.displayName}: “${n}”` : `${action === 'approve' ? 'Approved' : 'Turned down'} by ${user.displayName}.`,
      });
      if (action === 'approve') {
        await tell(tx, await notifier.staff(tx, [user.id, r.requestedBy]), r, {
          kind: 'request.to_fulfil',
          title: `Fulfil ${label(r)}`,
          body: `Approved by ${user.displayName}. Mark it fulfilled when it is in the crib.`,
        });
      }
      return c.json({ status });
    },
  );

  app.post(
    '/requests/:id/fulfil',
    requireRole('admin', 'storekeeper'),
    validate('param', idParam),
    validate('json', z.object({ note })),
    async (c) => {
      const user = currentUser(c);
      const tx = db(c);
      const r = await load(tx, c.req.valid('param').id);
      if (r.status !== 'approved') throw conflict('invalid_transition', 'Only approved requests can be fulfilled');
      const n = c.req.valid('json').note;
      await tx`UPDATE requests SET status = 'fulfilled', closed_by = ${user.id}, closed_at = now() WHERE id = ${r.id}`;
      await step(tx, r, user, 'fulfilled', n);
      await tell(tx, [r.requestedBy], r, {
        kind: 'request.fulfilled',
        title: `${label(r)} is ready`,
        body: n ? `${user.displayName}: “${n}”` : 'Collect it at the crib.',
      });
      return c.json({ status: 'fulfilled' });
    },
  );

  app.post('/requests/:id/cancel', requireAuth, validate('param', idParam), validate('json', z.object({ note })), async (c) => {
    const user = currentUser(c);
    const tx = db(c);
    const r = await load(tx, c.req.valid('param').id);
    if (r.requestedBy !== user.id) throw forbidden('Only the person who asked can withdraw a request');
    if (r.status !== 'submitted' && r.status !== 'reviewed') throw conflict('invalid_transition', `This request is already ${r.status}`);
    await tx`UPDATE requests SET status = 'cancelled', closed_by = ${user.id}, closed_at = now() WHERE id = ${r.id}`;
    await step(tx, r, user, 'cancelled', c.req.valid('json').note);
    return c.json({ status: 'cancelled' });
  });

  return app;
}
