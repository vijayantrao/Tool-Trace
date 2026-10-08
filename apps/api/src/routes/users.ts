import { Hono } from 'hono';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { currentUser, requireRole } from '../middleware/session.js';
import { createInvite } from '../services/invites.js';
import { ROLES, type AppEnv, type Deps } from '../types.js';

const idParam = z.object({ id: z.uuid() });

export function userRoutes({ sql, config }: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/users', requireRole('admin', 'auditor'), async (c) => {
    const users = await sql`
      SELECT id, email, display_name, role, is_active, created_at
      FROM users ORDER BY created_at`;
    return c.json({ users });
  });

  app.patch(
    '/users/:id',
    requireRole('admin'),
    validate('param', idParam),
    validate(
      'json',
      z
        .object({ role: z.enum(ROLES).optional(), isActive: z.boolean().optional() })
        .refine((v) => v.role !== undefined || v.isActive !== undefined, 'Nothing to update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const me = currentUser(c);
      // Prevents an admin from accidentally locking themselves out.
      if (id === me.id) throw forbidden('You cannot change your own role or status');

      const user = await sql.begin(async (tx) => {
        // Serialize admin changes so two concurrent requests can't remove the last admin.
        await tx`SELECT pg_advisory_xact_lock(727274002)`;
        // Re-check the requester under the lock: they may have been demoted a moment ago.
        const [stillAdmin] = await tx`SELECT 1 FROM users WHERE id = ${me.id} AND role = 'admin' AND is_active`;
        if (!stillAdmin) throw forbidden();
        const [target] = await tx<{ role: string; isActive: boolean }[]>`
          SELECT role, is_active FROM users WHERE id = ${id} FOR UPDATE`;
        if (!target) throw notFound('User');

        const losesAdmin =
          target.role === 'admin' && target.isActive && (body.isActive === false || (body.role && body.role !== 'admin'));
        if (losesAdmin) {
          const [admins] = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND is_active`;
          if ((admins?.count ?? 0) <= 1) throw conflict('last_admin', 'At least one active admin must remain');
        }

        const [updated] = await tx`
          UPDATE users SET
            role = COALESCE(${body.role ?? null}::user_role, role),
            is_active = COALESCE(${body.isActive ?? null}::boolean, is_active)
          WHERE id = ${id}
          RETURNING id, email, display_name, role, is_active`;
        // Deactivation or a role change takes effect immediately: kill existing sessions.
        await tx`DELETE FROM sessions WHERE user_id = ${id}`;
        return updated;
      });
      return c.json({ user });
    },
  );

  app.post(
    '/invites',
    requireRole('admin'),
    validate('json', z.object({ email: z.email().max(254), role: z.enum(ROLES) })),
    async (c) => {
      const body = c.req.valid('json');
      const [existing] = await sql`SELECT 1 FROM users WHERE email = ${body.email.toLowerCase()}`;
      if (existing) throw conflict('account_exists', 'An account with this email already exists');
      const invite = await createInvite(sql, config, { ...body, createdBy: currentUser(c).id });
      return c.json({ invite }, 201);
    },
  );

  app.get('/invites', requireRole('admin'), async (c) => {
    const invites = await sql`
      SELECT id, email, role, expires_at, created_at
      FROM invites WHERE used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`;
    return c.json({ invites });
  });

  app.delete('/invites/:id', requireRole('admin'), validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param');
    const deleted = await sql`DELETE FROM invites WHERE id = ${id} AND used_at IS NULL RETURNING id`;
    if (deleted.length === 0) throw notFound('Pending invite');
    return c.body(null, 204);
  });

  return app;
}
