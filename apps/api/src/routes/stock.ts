/**
 * Consumables and PPE, counted in quantities. Every change is a movement
 * (received, issued to a person, returned, or a count correction); the database
 * applies it to the item's quantity under a lock, so the count can't go negative
 * or drift from its history.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { conflict, notFound } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import { requestAcknowledgement } from '../services/acknowledgements.js';
import { lowStockMessage } from '../services/jobs.js';
import { price } from './tools.js';
import type { AppEnv, Deps } from '../types.js';

const idParam = z.object({ id: z.uuid() });
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/, 'Use 3-32 letters, digits or dashes');
const quantity = z.number().int().min(1).max(1_000_000);

const itemColumns = `
  i.id, i.code, i.name, i.kind, i.category, i.unit, i.location_id, l.name AS location_name, i.quantity,
  i.reorder_level, i.unit_price::float8 AS unit_price, i.abc_class, i.is_active,
  (i.reorder_level > 0 AND i.quantity <= i.reorder_level) AS low,
  (i.unit_price * i.quantity)::float8 AS stock_value, i.updated_at`;

export function stockRoutes({ notifier }: Deps) {
  const app = new Hono<AppEnv>();
  const staff = requireRole('admin', 'storekeeper');

  app.get(
    '/stock',
    requireAuth,
    validate(
      'query',
      z.object({
        kind: z.enum(['consumable', 'ppe']).optional(),
        q: z.string().trim().max(60).optional(),
        low: z.enum(['true']).optional(),
        inactive: z.enum(['true']).optional(),
      }),
    ),
    async (c) => {
      const f = c.req.valid('query');
      const tx = db(c);
      const like = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      const items = await tx`
        SELECT ${tx.unsafe(itemColumns)}
        FROM stock_items i JOIN locations l ON l.id = i.location_id
        WHERE (${f.kind ?? null}::text IS NULL OR i.kind = ${f.kind ?? null})
          AND (${like}::text IS NULL OR i.code ILIKE ${like} OR i.name ILIKE ${like} OR i.category ILIKE ${like})
          AND (${f.low === 'true'} = false OR (i.reorder_level > 0 AND i.quantity <= i.reorder_level))
          AND (i.is_active OR ${f.inactive === 'true'})
        ORDER BY (i.reorder_level > 0 AND i.quantity <= i.reorder_level) DESC, i.code
        LIMIT 1000`;
      return c.json({ items });
    },
  );

  /** What has been issued to me (PPE, consumables), newest first. */
  app.get('/stock/mine', requireAuth, async (c) => {
    const user = currentUser(c);
    const issues = await db(c)`
      SELECT m.id, m.item_id, i.code, i.name, i.unit, -m.quantity AS quantity, m.at, m.note, b.display_name AS by_name,
             a.status AS ack_status, a.id AS ack_id
      FROM stock_movements m JOIN stock_items i ON i.id = m.item_id JOIN users b ON b.id = m.by_user
      LEFT JOIN acknowledgements a ON a.subject_type = 'stock_issue' AND a.subject_id = m.id
      WHERE m.issued_to = ${user.id} AND m.kind = 'issue'
      ORDER BY m.at DESC LIMIT 100`;
    return c.json({ issues });
  });

  app.get('/stock/:id', requireAuth, validate('param', idParam), async (c) => {
    const tx = db(c);
    const { id } = c.req.valid('param');
    const [item] = await tx`SELECT ${tx.unsafe(itemColumns)} FROM stock_items i JOIN locations l ON l.id = i.location_id WHERE i.id = ${id}`;
    if (!item) throw notFound('Stock item');
    // Row-level security: technicians only get the movements that were issued to them.
    const movements = await tx`
      SELECT m.id, m.kind, m.quantity, m.balance_after, m.note, m.at, m.issued_to, t.display_name AS issued_to_name,
             b.display_name AS by_name, a.status AS ack_status
      FROM stock_movements m JOIN users b ON b.id = m.by_user LEFT JOIN users t ON t.id = m.issued_to
      LEFT JOIN acknowledgements a ON a.subject_type = 'stock_issue' AND a.subject_id = m.id
      WHERE m.item_id = ${id}
      ORDER BY m.at DESC LIMIT 100`;
    return c.json({ item, movements });
  });

  app.post(
    '/stock',
    staff,
    validate(
      'json',
      z.object({
        code,
        name: z.string().trim().min(1).max(120),
        kind: z.enum(['consumable', 'ppe']),
        category: z.string().trim().min(1).max(60),
        unit: z.string().trim().min(1).max(20).default('pcs'),
        locationId: z.uuid(),
        reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
        unitPrice: price.optional(),
        openingQuantity: z.number().int().min(0).max(1_000_000).default(0),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const user = currentUser(c);
      const tx = db(c);
      const [item] = await tx<{ id: string }[]>`
        INSERT INTO stock_items (code, name, kind, category, unit, location_id, reorder_level, unit_price)
        VALUES (${b.code}, ${b.name}, ${b.kind}, ${b.category}, ${b.unit}, ${b.locationId}, ${b.reorderLevel}, ${b.unitPrice ?? null})
        RETURNING id`;
      if (b.openingQuantity > 0) {
        await tx`
          INSERT INTO stock_movements (item_id, kind, quantity, note, by_user)
          VALUES (${item!.id}, 'receive', ${b.openingQuantity}, 'Opening stock', ${user.id})`;
      }
      const [created] = await tx`SELECT ${tx.unsafe(itemColumns)} FROM stock_items i JOIN locations l ON l.id = i.location_id WHERE i.id = ${item!.id}`;
      return c.json({ item: created }, 201);
    },
  );

  app.patch(
    '/stock/:id',
    staff,
    validate('param', idParam),
    validate(
      'json',
      z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          category: z.string().trim().min(1).max(60).optional(),
          unit: z.string().trim().min(1).max(20).optional(),
          locationId: z.uuid().optional(),
          reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
          unitPrice: price.nullable().optional(),
          isActive: z.boolean().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const tx = db(c);
      const rows = await tx`
        UPDATE stock_items SET
          name = COALESCE(${b.name ?? null}, name),
          category = COALESCE(${b.category ?? null}, category),
          unit = COALESCE(${b.unit ?? null}, unit),
          location_id = COALESCE(${b.locationId ?? null}::uuid, location_id),
          reorder_level = COALESCE(${b.reorderLevel ?? null}::int, reorder_level),
          unit_price = CASE WHEN ${b.unitPrice !== undefined} THEN ${b.unitPrice ?? null}::numeric ELSE unit_price END,
          is_active = COALESCE(${b.isActive ?? null}::boolean, is_active)
        WHERE id = ${id} RETURNING id`;
      if (!rows.length) throw notFound('Stock item');
      const [item] = await tx`SELECT ${tx.unsafe(itemColumns)} FROM stock_items i JOIN locations l ON l.id = i.location_id WHERE i.id = ${id}`;
      return c.json({ item });
    },
  );

  app.post(
    '/stock/:id/movements',
    staff,
    validate('param', idParam),
    validate(
      'json',
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('receive'), quantity, note: z.string().trim().max(300).optional() }),
        z.object({ kind: z.literal('issue'), quantity, issuedTo: z.uuid(), note: z.string().trim().max(300).optional() }),
        z.object({ kind: z.literal('return'), quantity, issuedTo: z.uuid(), note: z.string().trim().max(300).optional() }),
        // A stock count: the number actually on the shelf, and why it differs.
        z.object({ kind: z.literal('adjust'), countedQuantity: z.number().int().min(0).max(1_000_000), note: z.string().trim().min(3).max(300) }),
      ]),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      const tx = db(c);
      const [item] = await tx<{ code: string; name: string; unit: string; quantity: number; reorderLevel: number }[]>`
        SELECT code, name, unit, quantity, reorder_level FROM stock_items WHERE id = ${id} FOR UPDATE`;
      if (!item) throw notFound('Stock item');

      let delta: number;
      if (b.kind === 'adjust') {
        delta = b.countedQuantity - item.quantity;
        if (delta === 0) throw conflict('no_change', `The count already says ${item.quantity} ${item.unit}`);
      } else {
        delta = b.kind === 'issue' ? -b.quantity : b.quantity;
      }
      if (b.kind === 'issue' || b.kind === 'return') {
        const [person] = await tx<{ isActive: boolean; role: string }[]>`SELECT is_active, role FROM users WHERE id = ${b.issuedTo}`;
        if (!person?.isActive) throw notFound('Person');
        if (b.kind === 'issue' && person.role === 'auditor') throw conflict('invalid_holder', 'Auditors are not issued stock');
      }
      if (b.kind === 'issue' && item.quantity < b.quantity) {
        throw conflict('insufficient_stock', `Only ${item.quantity} ${item.unit} of ${item.code} in stock`);
      }

      const [movement] = await tx<{ id: string; balanceAfter: number }[]>`
        INSERT INTO stock_movements (item_id, kind, quantity, issued_to, note, by_user)
        VALUES (${id}, ${b.kind}, ${delta}, ${'issuedTo' in b ? b.issuedTo : null}, ${b.note || null}, ${user.id})
        RETURNING id, balance_after`;

      if (b.kind === 'issue' && b.issuedTo !== user.id) {
        await requestAcknowledgement(tx, notifier, {
          subjectType: 'stock_issue',
          subjectId: movement!.id,
          userId: b.issuedTo,
          requestedBy: user,
          summary: `${b.quantity} ${item.unit} ${item.name} (${item.code})`,
        });
      }
      // Just went to (or below) its reorder level: tell the crib now, not at the next weekly check.
      if (item.reorderLevel > 0 && movement!.balanceAfter <= item.reorderLevel && item.quantity > item.reorderLevel) {
        const [{ week }] = (await tx`SELECT to_char(now(), 'IYYY-"W"IW') AS week`) as unknown as [{ week: string }];
        await notifier.send(
          tx,
          await notifier.staff(tx),
          lowStockMessage({ id, code: item.code, name: item.name, quantity: movement!.balanceAfter, reorderLevel: item.reorderLevel, unit: item.unit }, week),
        );
      }
      return c.json({ movement: { id: movement!.id, quantity: delta, balanceAfter: movement!.balanceAfter } }, 201);
    },
  );

  return app;
}
