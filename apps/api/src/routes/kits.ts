/**
 * Tool kits: a set of tools issued and returned with one scan. Each tool in a
 * kit still gets its own check-out, so every rule applies to every piece; a kit
 * goes out only if every piece can, and comes back piece by piece, with a
 * checklist, so a missing piece is never silently "returned".
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { TxSql } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import { requestAcknowledgement } from '../services/acknowledgements.js';
import { checkOutTool, returnCheckout } from '../services/floor.js';
import { formatSiteTime } from '../lib/time.js';
import type { AppEnv, Deps } from '../types.js';

const idParam = z.object({ id: z.uuid() });
const tag = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/, 'Use 3-32 letters, digits or dashes');
const MAX_CHECKOUT_DAYS = 30;

interface Member {
  id: string;
  assetTag: string;
  name: string;
  status: string;
  calibrationExpired: boolean;
  checkoutId: string | null;
  holderId: string | null;
  holderName: string | null;
  kitIssueId: string | null;
  dueBackAt: Date | null;
}

async function members(tx: TxSql, kitId: string): Promise<Member[]> {
  return tx<Member[]>`
    SELECT t.id, t.asset_tag, t.name, t.status::text, t.category,
           (t.requires_calibration AND t.calibration_due_on < current_date) AS calibration_expired,
           t.calibration_due_on::text AS calibration_due_on,
           c.id AS checkout_id, c.holder_id, h.display_name AS holder_name, c.kit_issue_id, c.due_back_at,
           c.due_back_at < now() AS overdue
    FROM kit_items ki JOIN tools t ON t.id = ki.tool_id
    LEFT JOIN checkouts c ON c.tool_id = t.id AND c.returned_at IS NULL
    LEFT JOIN users h ON h.id = c.holder_id
    WHERE ki.kit_id = ${kitId}
    ORDER BY t.asset_tag`;
}

/** in_crib: every piece is home and usable. out: issued. partial: some pieces out or missing. unavailable: a piece can't be issued. */
function kitState(ms: Member[]) {
  if (ms.length === 0) return 'empty';
  const out = ms.filter((m) => m.status === 'checked_out').length;
  if (out === ms.length) return 'out';
  if (out > 0) return 'partial';
  return ms.every((m) => m.status === 'available' && !m.calibrationExpired) ? 'in_crib' : 'unavailable';
}

export function kitRoutes({ notifier }: Deps) {
  const app = new Hono<AppEnv>();
  const staff = requireRole('admin', 'storekeeper');

  const getKit = async (tx: TxSql, where: { id?: string; tag?: string }) => {
    const [kit] = await tx<{ id: string; assetTag: string; name: string; homeLocationId: string; homeLocationName: string; isActive: boolean }[]>`
      SELECT k.id, k.asset_tag, k.name, k.home_location_id, l.name AS home_location_name, k.is_active
      FROM kits k JOIN locations l ON l.id = k.home_location_id
      WHERE ${where.id ? tx`k.id = ${where.id}` : tx`k.asset_tag = ${where.tag!}`}`;
    if (!kit) throw notFound('Kit');
    const ms = await members(tx, kit.id);
    const issueIds = [...new Set(ms.map((m) => m.kitIssueId).filter(Boolean))] as string[];
    const [openIssue] = issueIds.length
      ? await tx`
          SELECT i.id, i.holder_id, h.display_name AS holder_name, i.issued_at, i.due_back_at, i.due_back_at < now() AS overdue,
                 b.display_name AS issued_by_name, a.status AS ack_status
          FROM kit_issues i JOIN users h ON h.id = i.holder_id JOIN users b ON b.id = i.issued_by
          LEFT JOIN acknowledgements a ON a.subject_type = 'kit_issue' AND a.subject_id = i.id
          WHERE i.id = ${issueIds[0]!}`
      : [];
    return { ...kit, state: kitState(ms), tools: ms, openIssue: openIssue ?? null };
  };

  app.get('/kits', requireAuth, async (c) => {
    const tx = db(c);
    const kits = await tx<{ id: string; assetTag: string; name: string; homeLocationName: string; isActive: boolean }[]>`
      SELECT k.id, k.asset_tag, k.name, l.name AS home_location_name, k.is_active
      FROM kits k JOIN locations l ON l.id = k.home_location_id
      ORDER BY k.is_active DESC, k.asset_tag`;
    const all = await tx<(Member & { kitId: string })[]>`
      SELECT ki.kit_id, t.id, t.asset_tag, t.name, t.status::text,
             (t.requires_calibration AND t.calibration_due_on < current_date) AS calibration_expired,
             c.holder_id, h.display_name AS holder_name, c.due_back_at
      FROM kit_items ki JOIN tools t ON t.id = ki.tool_id
      LEFT JOIN checkouts c ON c.tool_id = t.id AND c.returned_at IS NULL
      LEFT JOIN users h ON h.id = c.holder_id`;
    return c.json({
      kits: kits.map((k) => {
        const ms = all.filter((m) => m.kitId === k.id);
        const holder = ms.find((m) => m.holderName);
        return { ...k, toolCount: ms.length, state: kitState(ms), holderName: holder?.holderName ?? null, dueBackAt: holder?.dueBackAt ?? null };
      }),
    });
  });

  app.get('/kits/by-tag/:tag', requireAuth, validate('param', z.object({ tag })), async (c) =>
    c.json({ kit: await getKit(db(c), { tag: c.req.valid('param').tag }) }),
  );

  app.get('/kits/:id', requireAuth, validate('param', idParam), async (c) =>
    c.json({ kit: await getKit(db(c), { id: c.req.valid('param').id }) }),
  );

  app.post(
    '/kits',
    staff,
    validate('json', z.object({ assetTag: tag, name: z.string().trim().min(1).max(120), homeLocationId: z.uuid(), toolTags: z.array(tag).max(100).default([]) })),
    async (c) => {
      const b = c.req.valid('json');
      const tx = db(c);
      const [kit] = await tx<{ id: string }[]>`
        INSERT INTO kits (asset_tag, name, home_location_id) VALUES (${b.assetTag}, ${b.name}, ${b.homeLocationId}) RETURNING id`;
      for (const t of new Set(b.toolTags)) await addTool(tx, kit!.id, t);
      return c.json({ kit: await getKit(tx, { id: kit!.id }) }, 201);
    },
  );

  app.patch(
    '/kits/:id',
    staff,
    validate('param', idParam),
    validate(
      'json',
      z
        .object({ name: z.string().trim().min(1).max(120).optional(), homeLocationId: z.uuid().optional(), isActive: z.boolean().optional() })
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const tx = db(c);
      const rows = await tx`
        UPDATE kits SET name = COALESCE(${b.name ?? null}, name), home_location_id = COALESCE(${b.homeLocationId ?? null}::uuid, home_location_id),
               is_active = COALESCE(${b.isActive ?? null}::boolean, is_active)
        WHERE id = ${id} RETURNING id`;
      if (!rows.length) throw notFound('Kit');
      return c.json({ kit: await getKit(tx, { id }) });
    },
  );

  const addTool = async (tx: TxSql, kitId: string, assetTag: string) => {
    const [t] = await tx<{ id: string; kitTag: string | null }[]>`
      SELECT t.id, k.asset_tag AS kit_tag FROM tools t
      LEFT JOIN kit_items ki ON ki.tool_id = t.id LEFT JOIN kits k ON k.id = ki.kit_id
      WHERE t.asset_tag = ${assetTag}`;
    if (!t) throw notFound(`Tool ${assetTag}`);
    if (t.kitTag) throw conflict('already_in_kit', `${assetTag} is already in kit ${t.kitTag}`);
    await tx`INSERT INTO kit_items (kit_id, tool_id) VALUES (${kitId}, ${t.id})`;
  };

  app.post('/kits/:id/tools', staff, validate('param', idParam), validate('json', z.object({ assetTag: tag })), async (c) => {
    const { id } = c.req.valid('param');
    const tx = db(c);
    await getKit(tx, { id });
    await addTool(tx, id, c.req.valid('json').assetTag);
    return c.json({ kit: await getKit(tx, { id }) }, 201);
  });

  app.delete('/kits/:id/tools/:toolId', staff, validate('param', z.object({ id: z.uuid(), toolId: z.uuid() })), async (c) => {
    const { id, toolId } = c.req.valid('param');
    const tx = db(c);
    const gone = await tx`DELETE FROM kit_items WHERE kit_id = ${id} AND tool_id = ${toolId} RETURNING tool_id`;
    if (!gone.length) throw notFound('Tool in this kit');
    return c.json({ kit: await getKit(tx, { id }) });
  });

  // ---- Issue the whole kit ---------------------------------------------------
  app.post(
    '/kits/:id/checkout',
    requireRole('admin', 'storekeeper', 'technician'),
    validate('param', idParam),
    validate('json', z.object({ holderId: z.uuid().optional(), dueBackAt: z.iso.datetime({ offset: true }) })),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      const holderId = b.holderId ?? user.id;
      if (user.role === 'technician' && holderId !== user.id) throw forbidden('Technicians can only check kits out to themselves');
      const due = new Date(b.dueBackAt);
      if (due.getTime() <= Date.now()) throw conflict('invalid_due_date', 'Due-back time must be in the future');
      if (due.getTime() > Date.now() + MAX_CHECKOUT_DAYS * 86_400_000) throw conflict('invalid_due_date', `Checkouts can last at most ${MAX_CHECKOUT_DAYS} days`);

      const tx = db(c);
      const kit = await getKit(tx, { id });
      if (!kit.isActive) throw conflict('kit_inactive', 'This kit is no longer in use');
      if (kit.tools.length === 0) throw conflict('kit_empty', 'This kit has no tools in it yet');
      // All or nothing: say exactly which pieces stop it.
      const blocked = kit.tools.filter((m) => m.status !== 'available' || m.calibrationExpired);
      if (blocked.length) {
        const why = blocked.map((m) => `${m.assetTag} (${m.calibrationExpired && m.status === 'available' ? 'calibration expired' : m.status.replace('_', ' ')})`);
        throw conflict('kit_incomplete', `The kit can't go out: ${why.join(', ')}`);
      }
      const [issue] = await tx<{ id: string }[]>`
        INSERT INTO kit_issues (kit_id, holder_id, issued_by, due_back_at) VALUES (${id}, ${holderId}, ${user.id}, ${due})
        RETURNING id`;
      for (const m of kit.tools) {
        await checkOutTool(tx, { tool: { id: m.id }, holderId, issuedBy: user.id, dueBackAt: due, kitIssueId: issue!.id });
      }
      if (holderId !== user.id) {
        await requestAcknowledgement(tx, notifier, {
          subjectType: 'kit_issue',
          subjectId: issue!.id,
          userId: holderId,
          requestedBy: user,
          summary: `kit ${kit.assetTag} ${kit.name} (${kit.tools.length} tools)`,
          facts: [['Tools', kit.tools.map((m) => m.assetTag).join(', ')], ['Due back', formatSiteTime(due)]],
        });
      }
      return c.json({ kit: await getKit(tx, { id }) }, 201);
    },
  );

  // ---- Receive it back, piece by piece ---------------------------------------
  app.post(
    '/kits/:id/return',
    requireRole('admin', 'storekeeper'),
    validate('param', idParam),
    validate(
      'json',
      z.object({
        tools: z
          .array(z.object({ toolId: z.uuid(), condition: z.enum(['ok', 'damaged', 'needs_calibration', 'missing']) }))
          .min(1)
          .max(100),
        notes: z.string().trim().max(500).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      const tx = db(c);
      const kit = await getKit(tx, { id });
      const out = kit.tools.filter((m) => m.checkoutId && m.kitIssueId);
      if (out.length === 0) throw conflict('kit_not_out', 'Nothing from this kit is checked out');
      // Every piece still out has to be accounted for: returned in some condition, or missing.
      const said = new Map(b.tools.map((t) => [t.toolId, t.condition]));
      const unaccounted = out.filter((m) => !said.has(m.id));
      if (unaccounted.length) throw badRequest('checklist_incomplete', `Tick off every piece: ${unaccounted.map((m) => m.assetTag).join(', ')}`);

      const missing: Member[] = [];
      let returned = 0;
      for (const m of out) {
        const condition = said.get(m.id)!;
        if (condition === 'missing') {
          missing.push(m);
          continue;
        }
        await returnCheckout(tx, { checkoutId: m.checkoutId!, receivedBy: user.id, condition, notes: b.notes ?? null });
        returned++;
      }
      if (missing.length) {
        const holderId = out[0]!.holderId;
        const list = missing.map((m) => `${m.assetTag} ${m.name}`).join(', ');
        await notifier.send(tx, [holderId, ...(await notifier.staff(tx, [user.id]))], {
          kind: 'kit.incomplete_return',
          title: `Kit ${kit.assetTag} came back without ${missing.length === 1 ? missing[0]!.assetTag : `${missing.length} tools`}`,
          body: `Still out with ${out[0]!.holderName}: ${list}.`,
          link: `/kits/${kit.id}`,
        });
      }
      return c.json({ returned, missing: missing.map((m) => m.assetTag), kit: await getKit(tx, { id }) });
    },
  );

  return app;
}
