import { Hono } from 'hono';
import { z } from 'zod';
import { conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

const MAX_CHECKOUT_DAYS = 30;

export function checkoutRoutes({ sql }: Deps) {
  const app = new Hono<AppEnv>();

  app.get(
    '/checkouts',
    requireAuth,
    validate(
      'query',
      z.object({
        open: z.enum(['true', 'false']).optional(),
        overdue: z.enum(['true']).optional(),
        holderId: z.uuid().optional(),
      }),
    ),
    async (c) => {
      const f = c.req.valid('query');
      const user = currentUser(c);
      // Technicians only ever see their own checkouts, whatever filter they send.
      const holderId = user.role === 'technician' ? user.id : (f.holderId ?? null);
      const open = f.open === undefined ? null : f.open === 'true';
      const checkouts = await sql`
        SELECT c.id, c.tool_id, t.asset_tag, t.name AS tool_name,
               c.holder_id, h.display_name AS holder_name, c.issued_by,
               c.checked_out_at, c.due_back_at, c.returned_at, c.condition_on_return, c.notes,
               (c.returned_at IS NULL AND c.due_back_at < now()) AS overdue
        FROM checkouts c
        JOIN tools t ON t.id = c.tool_id
        JOIN users h ON h.id = c.holder_id
        WHERE (${holderId}::uuid IS NULL OR c.holder_id = ${holderId}::uuid)
          AND (${open}::boolean IS NULL OR (c.returned_at IS NULL) = ${open}::boolean)
          AND (${f.overdue === 'true'} = false OR (c.returned_at IS NULL AND c.due_back_at < now()))
        ORDER BY c.checked_out_at DESC
        LIMIT 500`;
      return c.json({ checkouts });
    },
  );

  app.post(
    '/checkouts',
    requireRole('admin', 'storekeeper', 'technician'),
    validate(
      'json',
      z
        .object({
          toolId: z.uuid().optional(),
          assetTag: z.string().trim().max(32).optional(),
          holderId: z.uuid().optional(),
          dueBackAt: z.iso.datetime({ offset: true }),
        })
        .refine((v) => Boolean(v.toolId) !== Boolean(v.assetTag), 'Provide exactly one of toolId or assetTag'),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const user = currentUser(c);
      const holderId = b.holderId ?? user.id;
      if (user.role === 'technician' && holderId !== user.id) {
        throw forbidden('Technicians can only check tools out to themselves');
      }
      const due = new Date(b.dueBackAt);
      const now = Date.now();
      if (due.getTime() <= now) throw conflict('invalid_due_date', 'Due-back time must be in the future');
      if (due.getTime() > now + MAX_CHECKOUT_DAYS * 86_400_000) {
        throw conflict('invalid_due_date', `Checkouts can last at most ${MAX_CHECKOUT_DAYS} days`);
      }

      const checkout = await sql.begin(async (tx) => {
        const [holder] = await tx<{ isActive: boolean; role: string }[]>`
          SELECT is_active, role FROM users WHERE id = ${holderId}`;
        if (!holder || !holder.isActive) throw notFound('Holder');
        if (holder.role === 'auditor') throw conflict('invalid_holder', 'Auditors cannot hold tools');

        // Lock the tool row so concurrent checkouts are serialized.
        const [tool] = await tx<{ id: string; assetTag: string; status: string; calibrationExpired: boolean }[]>`
          SELECT id, asset_tag, status,
                 (requires_calibration AND calibration_due_on < current_date) AS calibration_expired
          FROM tools
          WHERE ${b.toolId ? tx`id = ${b.toolId}` : tx`asset_tag = ${b.assetTag!.toUpperCase()}`}
          FOR UPDATE`;
        if (!tool) throw notFound('Tool');
        if (tool.status !== 'available') {
          throw conflict('tool_unavailable', `Tool ${tool.assetTag} is not available (${tool.status})`);
        }
        if (tool.calibrationExpired) {
          throw conflict('calibration_expired', `Tool ${tool.assetTag} is past its calibration date and is locked`);
        }

        const [row] = await tx`
          INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at)
          VALUES (${tool.id}, ${holderId}, ${user.id}, ${due})
          RETURNING id, tool_id, holder_id, issued_by, checked_out_at, due_back_at`;
        await tx`UPDATE tools SET status = 'checked_out' WHERE id = ${tool.id}`;
        return row;
      });
      return c.json({ checkout }, 201);
    },
  );

  app.post(
    '/checkouts/:id/return',
    requireRole('admin', 'storekeeper'),
    validate('param', z.object({ id: z.uuid() })),
    validate(
      'json',
      z.object({
        condition: z.enum(['ok', 'damaged', 'needs_calibration']),
        notes: z.string().trim().max(500).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      if (!user) throw unauthorized();

      const checkout = await sql.begin(async (tx) => {
        const [row] = await tx<{ toolId: string }[]>`
          UPDATE checkouts
          SET returned_at = now(), received_by = ${user.id},
              condition_on_return = ${b.condition}, notes = ${b.notes ?? null}
          WHERE id = ${id} AND returned_at IS NULL
          RETURNING id, tool_id, holder_id, checked_out_at, due_back_at, returned_at, condition_on_return`;
        if (!row) {
          const [exists] = await tx`SELECT 1 FROM checkouts WHERE id = ${id}`;
          if (exists) throw conflict('already_returned', 'This checkout was already returned');
          throw notFound('Checkout');
        }
        // Anything not returned in good condition is quarantined until inspected.
        await tx`
          UPDATE tools SET status = ${b.condition === 'ok' ? 'available' : 'quarantined'}::tool_status
          WHERE id = ${row.toolId}`;
        return row;
      });
      return c.json({ checkout });
    },
  );

  return app;
}
