import { Hono } from 'hono';
import { z } from 'zod';
import { conflict, forbidden, unauthorized } from '../lib/errors.js';
import { checkOutTool, returnCheckout } from '../services/floor.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

const MAX_CHECKOUT_DAYS = 30;

export function checkoutRoutes(_deps: Deps) {
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
      const checkouts = await db(c)`
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

      const checkout = await checkOutTool(db(c), {
        tool: b.toolId ? { id: b.toolId } : { assetTag: b.assetTag! },
        holderId,
        issuedBy: user.id,
        dueBackAt: due,
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

      const checkout = await returnCheckout(db(c), {
        checkoutId: id,
        receivedBy: user.id,
        condition: b.condition,
        notes: b.notes,
      });
      return c.json({ checkout });
    },
  );

  return app;
}
