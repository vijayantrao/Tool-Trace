/**
 * The public demo: fictional data, one-click personas, and a nightly reset.
 *
 * Safety: demo mode signs people in without a passkey, so it must only ever
 * run against a database that holds nothing real. A database becomes a demo
 * database only if it has no real accounts at that moment; it is then marked
 * (the demo_instance table), and the API refuses DEMO_MODE on anything unmarked.
 */
import { randomBytes } from 'node:crypto';
import type { Sql, TxSql } from '../db.js';
import { AUDIT_LOCK_ID } from '../middleware/db.js';
import { migrate } from '../migrate.js';

type Db = Sql | TxSql;

export const DEMO_DOMAIN = 'demo.tooltrace.example';
const HISTORY_DOMAIN = 'history.tooltrace.example'; // the ML job's synthetic history (ml/tooltrace_ml/synth.py)

export const PERSONAS = {
  admin: { name: 'Priya Nair', role: 'admin', badge: null },
  storekeeper: { name: 'Ravi Kumar', role: 'storekeeper', badge: null },
  technician: { name: 'Asha Verma', role: 'technician', badge: 'C0FFEE99' }, // the Wokwi key fob
  auditor: { name: 'Meera Iyer', role: 'auditor', badge: null },
} as const;
export type Persona = keyof typeof PERSONAS;
export const PERSONA_NAMES = Object.keys(PERSONAS) as Persona[];
export const personaEmail = (p: Persona) => `${p}@${DEMO_DOMAIN}`;
export const isPersonaEmail = (email: string) => email.endsWith(`@${DEMO_DOMAIN}`);

const LOCATIONS = [
  { name: 'Main Tool Crib', kind: 'crib' },
  { name: 'Assembly Bay 1', kind: 'bay' },
  { name: 'Assembly Bay 2', kind: 'bay' },
  { name: 'Paint Line', kind: 'line' },
  { name: 'External Calibration Lab', kind: 'external' },
];

// daysAgo: when it was last calibrated. With the interval this sets the calibration state.
const TOOLS = [
  { tag: 'TW-0101', name: 'Torque Wrench 20-100 Nm', category: 'Torque', interval: 180, daysAgo: 30, price: 18500, make: 'Norbar' },
  { tag: 'TW-0102', name: 'Torque Wrench 60-340 Nm', category: 'Torque', interval: 180, daysAgo: 172, price: 42000, make: 'Norbar' },
  { tag: 'TW-0103', name: 'Torque Wrench 5-25 Nm', category: 'Torque', interval: 180, daysAgo: 200, price: 14500, make: 'Stahlwille' },
  { tag: 'MM-0201', name: 'Digital Multimeter', category: 'Electrical', interval: 365, daysAgo: 90, price: 9800, make: 'Fluke' },
  { tag: 'VC-0301', name: 'Vernier Caliper 300 mm', category: 'Measuring', interval: 365, daysAgo: 20, price: 6200, make: 'Mitutoyo' },
  { tag: 'DFT-0401', name: 'Paint Thickness Gauge', category: 'Measuring', interval: 90, daysAgo: 85, price: 38000, make: 'Elcometer' },
  { tag: 'CR-0501', name: 'Hydraulic Crimping Tool', category: 'Electrical', interval: null, daysAgo: null, price: 24000, make: 'Dowells' },
  { tag: 'BS-0601', name: 'Inspection Borescope', category: 'Inspection', interval: null, daysAgo: null, price: 52000, make: 'Olympus' },
  { tag: 'IW-0701', name: 'Pneumatic Impact Wrench', category: 'Power Tools', interval: null, daysAgo: null, price: 16500, make: 'Ingersoll Rand' },
];

// RFID tags matching the Wokwi simulator's preset cards, so the demo station works out of the box.
const TAGS: [string, string][] = [
  ['TW-0101', '11223344'], // green card
  ['MM-0201', '55667788'], // yellow card
  ['TW-0103', 'AABBCCDD'], // red card: calibration expired, shows LOCKED
  ['VC-0301', '04112233445566'], // NFC tag
];

/** Locations and tools in a range of calibration states. Idempotent. */
export async function seedDemoTools(sql: Db): Promise<void> {
  for (const l of LOCATIONS) {
    await sql`INSERT INTO locations (name, kind) VALUES (${l.name}, ${l.kind}) ON CONFLICT (name) DO NOTHING`;
  }
  const [mainCrib] = await sql<{ id: string }[]>`SELECT id FROM locations WHERE name = 'Main Tool Crib'`;
  for (const t of TOOLS) {
    const cal = t.interval !== null;
    await sql`
      INSERT INTO tools (asset_tag, name, category, home_location_id, requires_calibration,
                         calibration_interval_days, last_calibrated_on, calibration_due_on, unit_price, make)
      VALUES (${t.tag}, ${t.name}, ${t.category}, ${mainCrib!.id}, ${cal}, ${t.interval},
              ${cal ? sql`current_date - ${t.daysAgo}::int` : null},
              ${cal ? sql`current_date - ${t.daysAgo}::int + ${t.interval}::int` : null}, ${t.price}, ${t.make})
      ON CONFLICT (asset_tag) DO NOTHING`;
  }
  for (const [tag, uid] of TAGS) {
    await sql`
      UPDATE tools SET rfid_uid = ${uid}
      WHERE asset_tag = ${tag} AND rfid_uid IS NULL
        AND NOT EXISTS (SELECT 1 FROM tools WHERE rfid_uid = ${uid})
        AND NOT EXISTS (SELECT 1 FROM users WHERE badge_uid = ${uid})`;
  }
}

export const DEMO_COUNTS = { locations: LOCATIONS.length, tools: TOOLS.length, tags: TAGS.length };

/** The four one-click demo accounts. They have no passkeys: they exist only in demo mode. */
async function seedPersonas(sql: Db): Promise<void> {
  for (const p of PERSONA_NAMES) {
    const { name, role, badge } = PERSONAS[p];
    await sql`
      INSERT INTO users (email, display_name, role, webauthn_user_id, badge_uid)
      VALUES (${personaEmail(p)}, ${name}, ${role}, ${randomBytes(32)}, ${badge})`;
  }
  // So the technician's home screen isn't empty: one tool out, issued at the crib.
  await sql`
    INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at)
    SELECT t.id, h.id, s.id, now() + interval '6 hours'
    FROM tools t, users h, users s
    WHERE t.asset_tag = 'MM-0201' AND h.email = ${personaEmail('technician')} AND s.email = ${personaEmail('storekeeper')}`;
}

export async function isDemoDatabase(sql: Db): Promise<boolean> {
  const [row] = await sql<{ t: string | null }[]>`SELECT to_regclass('public.demo_instance')::text AS t`;
  return row!.t !== null;
}

/**
 * Wipes every table and loads the demo again, in one transaction.
 * Refuses unless the database is already a demo database, or has no real accounts yet.
 */
export async function resetDemo(sql: Sql): Promise<{ wiped: number }> {
  await migrate(sql);
  let wiped = 0;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;
    if (!(await isDemoDatabase(tx))) {
      const [real] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM users
        WHERE email NOT LIKE ${`%@${DEMO_DOMAIN}`} AND email NOT LIKE ${`%@${HISTORY_DOMAIN}`}`;
      if (real!.n > 0) {
        throw new Error(
          `Refusing to turn this database into a demo: it has ${real!.n} real account(s). Use a separate database for the demo.`,
        );
      }
      await tx`CREATE TABLE demo_instance (marked_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL)`;
      await tx`INSERT INTO demo_instance (note) VALUES ('Public demo database: wiped and reloaded every night.')`;
    }
    const tables = await tx<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'demo_instance')
      ORDER BY tablename`;
    wiped = tables.length;
    // The audit log refuses TRUNCATE for everyone; the demo reset is the one sanctioned exception,
    // and it is the first entry of the new chain.
    await tx`ALTER TABLE audit_log DISABLE TRIGGER USER`;
    await tx.unsafe(`TRUNCATE ${tables.map((t) => `"${t.name.replace(/"/g, '')}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await tx`ALTER TABLE audit_log ENABLE TRIGGER USER`;
    await tx`SELECT audit_append('demo.reset', 'dataset', 'demo', ${tx.json({ tablesWiped: wiped, ...DEMO_COUNTS, personas: PERSONA_NAMES.length })})`;
    await seedDemoTools(tx);
    await seedPersonas(tx);
    await seedDemoExtras(tx);
  });
  return { wiped };
}

/**
 * The rest of the public demo: a kit, a tool at the calibration lab, PPE and consumables,
 * requests at every step, and things waiting for the personas to confirm or approve.
 * Kit tools are tagged so they sort before DFT-0401: the ML job's synthetic history
 * leaves the last three free tools checked out, and those stay DFT-0401, IW-0701 and TW-0102.
 */
async function seedDemoExtras(sql: Db): Promise<void> {
  const person = async (p: Persona) => (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${personaEmail(p)}`)[0]!.id;
  const [priya, ravi, asha] = [await person('admin'), await person('storekeeper'), await person('technician')];
  const [crib] = await sql<{ id: string }[]>`SELECT id FROM locations WHERE name = 'Main Tool Crib'`;
  const [ppeStore] = await sql<{ id: string }[]>`INSERT INTO locations (name, kind) VALUES ('PPE Store', 'crib') RETURNING id`;
  const tool = (tag: string, name: string, category: string, price: number, make: string, cal?: { interval: number; daysAgo: number }) => sql`
    INSERT INTO tools (asset_tag, name, category, home_location_id, unit_price, make, requires_calibration,
                       calibration_interval_days, last_calibrated_on, calibration_due_on)
    VALUES (${tag}, ${name}, ${category}, ${crib!.id}, ${price}, ${make}, ${Boolean(cal)}, ${cal?.interval ?? null},
            ${cal ? sql`current_date - ${cal.daysAgo}::int` : null}, ${cal ? sql`current_date - ${cal.daysAgo}::int + ${cal.interval}::int` : null})`;

  // A kit, in the crib, ready to try.
  await tool('AK-0901', 'Allen Key Set 1.5-10 mm', 'Hand Tools', 1450, 'Taparia');
  await tool('CC-0902', 'Cable Cutter 600 mm', 'Electrical', 3200, 'Jhalani');
  await tool('CP-0903', 'Insulated Combination Pliers', 'Electrical', 1650, 'Knipex');
  const [kit] = await sql<{ id: string }[]>`
    INSERT INTO kits (asset_tag, name, home_location_id) VALUES ('KIT-0001', 'Electrician''s Kit', ${crib!.id}) RETURNING id`;
  await sql`INSERT INTO kit_items (kit_id, tool_id) SELECT ${kit!.id}, id FROM tools WHERE asset_tag IN ('AK-0901', 'CC-0902', 'CP-0903')`;

  // A gauge away at the calibration lab, sent three days ago.
  await tool('PG-0801', 'Pressure Gauge 0-250 bar', 'Pressure', 7800, 'Baumer', { interval: 365, daysAgo: 360 });
  const [gauge] = await sql<{ id: string }[]>`SELECT id FROM tools WHERE asset_tag = 'PG-0801'`;
  await sql`
    INSERT INTO calibration_jobs (tool_id, lab_name, notes, expected_back_on, previous_status, sent_by, sent_at, token_hash, token_expires_at)
    VALUES (${gauge!.id}, 'External Calibration Lab', 'Annual calibration, NABL certificate please', current_date + 4, 'available',
            ${ravi}, now() - interval '3 days', ${randomBytes(32)}, now() + interval '57 days')`;
  await sql`UPDATE tools SET status = 'at_calibration' WHERE id = ${gauge!.id}`;

  // PPE and consumables, two of them due for reordering.
  const items: [string, string, 'ppe' | 'consumable', string, string, number, number, number][] = [
    ['PPE-GLV-01', 'Cut-resistant gloves', 'ppe', 'Hand protection', 'pairs', 20, 180, 64],
    ['PPE-GOG-01', 'Safety goggles', 'ppe', 'Eye protection', 'pcs', 10, 220, 8],
    ['PPE-EAR-01', 'Ear plugs', 'ppe', 'Hearing protection', 'pairs', 100, 6, 450],
    ['PPE-HLM-01', 'Safety helmet', 'ppe', 'Head protection', 'pcs', 5, 450, 12],
    ['CON-TIE-01', 'Cable ties 200 mm', 'consumable', 'Electrical', 'pcs', 500, 1.5, 1800],
    ['CON-DSC-01', 'Grinding disc 100 mm', 'consumable', 'Abrasives', 'pcs', 25, 85, 30],
    ['CON-SLV-01', 'Heat-shrink sleeve 6 mm', 'consumable', 'Electrical', 'm', 50, 12, 40],
  ];
  const stockId: Record<string, string> = {};
  for (const [code, name, kind, category, unit, reorder, price, qty] of items) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO stock_items (code, name, kind, category, unit, location_id, reorder_level, unit_price)
      VALUES (${code}, ${name}, ${kind}, ${category}, ${unit}, ${ppeStore!.id}, ${reorder}, ${price}) RETURNING id`;
    stockId[code] = row!.id;
    await sql`
      INSERT INTO stock_movements (item_id, kind, quantity, note, by_user, at)
      VALUES (${row!.id}, 'receive', ${qty + (code === 'PPE-GLV-01' ? 2 : code === 'PPE-GOG-01' ? 1 : 0)}, 'Opening stock', ${ravi}, now() - interval '20 days')`;
  }
  const [goggles] = await sql<{ id: string }[]>`
    INSERT INTO stock_movements (item_id, kind, quantity, issued_to, note, by_user, at)
    VALUES (${stockId['PPE-GOG-01']!}, 'issue', -1, ${asha}, 'Grinding work', ${ravi}, now() - interval '6 days') RETURNING id`;
  await sql`
    INSERT INTO acknowledgements (subject_type, subject_id, user_id, requested_by, summary, status, responded_at, responded_via, created_at)
    VALUES ('stock_issue', ${goggles!.id}, ${asha}, ${ravi}, '1 pcs Safety goggles (PPE-GOG-01)', 'acknowledged', now() - interval '6 days', 'app', now() - interval '6 days')`;
  const [gloves] = await sql<{ id: string }[]>`
    INSERT INTO stock_movements (item_id, kind, quantity, issued_to, note, by_user)
    VALUES (${stockId['PPE-GLV-01']!}, 'issue', -2, ${asha}, 'Cable tray work', ${ravi}) RETURNING id`;

  // Waiting for Asha to confirm: the multimeter and the gloves Ravi issued her.
  const [meter] = await sql<{ id: string }[]>`
    SELECT c.id FROM checkouts c JOIN tools t ON t.id = c.tool_id WHERE t.asset_tag = 'MM-0201' AND c.returned_at IS NULL`;
  for (const [type, id, summary] of [
    ['checkout', meter!.id, 'MM-0201 Digital Multimeter'],
    ['stock_issue', gloves!.id, '2 pairs Cut-resistant gloves (PPE-GLV-01)'],
  ] as const) {
    await sql`
      INSERT INTO acknowledgements (subject_type, subject_id, user_id, requested_by, summary, token_hash)
      VALUES (${type}, ${id}, ${asha}, ${ravi}, ${summary}, ${randomBytes(32)})`;
    await sql`SELECT enqueue_notification(${asha}, 'issue.confirm', ${`Ravi Kumar issued you ${summary}`},
      'Please confirm you received it, or say if you did not.', '/', NULL, false, '', '', '')`;
  }

  // Requests at each step: one for Ravi to review, one for Priya to approve, one done.
  const request = async (r: { kind: string; reason: string; title: string; details: string; qty: number; cost: number | null; tool?: string; item?: string; daysAgo: number }) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO requests (kind, reason, title, details, quantity, estimated_cost, tool_id, stock_item_id, requested_by, created_at)
      VALUES (${r.kind}, ${r.reason}, ${r.title}, ${r.details}, ${r.qty}, ${r.cost},
              ${r.tool ? sql`(SELECT id FROM tools WHERE asset_tag = ${r.tool})` : null}, ${r.item ?? null}, ${asha},
              now() - make_interval(days => ${r.daysAgo}))
      RETURNING id`;
    await sql`INSERT INTO request_events (request_id, action, by_user, note, at)
              VALUES (${row!.id}, 'submitted', ${asha}, ${r.details}, now() - make_interval(days => ${r.daysAgo}))`;
    return row!.id;
  };
  const step = async (id: string, action: string, by: string, note: string | null, daysAgo: number) => {
    const set =
      action === 'reviewed' ? sql`status = 'reviewed', reviewed_by = ${by}, reviewed_at = now() - make_interval(days => ${daysAgo})`
      : action === 'approved' ? sql`status = 'approved', decided_by = ${by}, decided_at = now() - make_interval(days => ${daysAgo})`
      : sql`status = 'fulfilled', closed_by = ${by}, closed_at = now() - make_interval(days => ${daysAgo})`;
    await sql`UPDATE requests SET ${set} WHERE id = ${id}`;
    await sql`INSERT INTO request_events (request_id, action, by_user, note, at)
              VALUES (${id}, ${action}, ${by}, ${note}, now() - make_interval(days => ${daysAgo}))`;
  };
  const done = await request({ kind: 'stock', reason: 'used_up', title: 'Heat-shrink sleeve 6 mm', details: 'Running low on the loom line', qty: 100, cost: 1200, item: stockId['CON-SLV-01']!, daysAgo: 12 });
  await step(done, 'reviewed', ravi, null, 11);
  await step(done, 'approved', priya, 'Order with the next electrical PO', 10);
  await step(done, 'fulfilled', ravi, 'Received 100 m', 4);
  const toApprove = await request({ kind: 'new_tool', reason: 'kaizen', title: 'Magnetic parts tray', details: 'Stops small bolts rolling off the bogie stand', qty: 4, cost: 1600, daysAgo: 2 });
  await step(toApprove, 'reviewed', ravi, 'Good idea, cheap', 1);
  await sql`SELECT enqueue_notification(${priya}, 'request.to_approve', 'Approve REQ-0002 Magnetic parts tray?',
    'Ravi Kumar reviewed it and passed it on for approval.', ${`/requests?id=${toApprove}`}, NULL, false, '', '', '')`;
  const toReview = await request({ kind: 'replacement', reason: 'damaged', title: 'Hydraulic Crimping Tool', details: 'Die holder cracked', qty: 1, cost: 24000, tool: 'CR-0501', daysAgo: 0 });
  await sql`SELECT enqueue_notification(${ravi}, 'request.submitted', 'Asha Verma asks for Hydraulic Crimping Tool',
    'Replacement against damaged. Review it in ToolTrace.', ${`/requests?id=${toReview}`}, NULL, false, '', '', '')`;
}
