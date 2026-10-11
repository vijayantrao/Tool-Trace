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
  { tag: 'TW-0101', name: 'Torque Wrench 20-100 Nm', category: 'Torque', interval: 180, daysAgo: 30 },
  { tag: 'TW-0102', name: 'Torque Wrench 60-340 Nm', category: 'Torque', interval: 180, daysAgo: 172 },
  { tag: 'TW-0103', name: 'Torque Wrench 5-25 Nm', category: 'Torque', interval: 180, daysAgo: 200 },
  { tag: 'MM-0201', name: 'Digital Multimeter', category: 'Electrical', interval: 365, daysAgo: 90 },
  { tag: 'VC-0301', name: 'Vernier Caliper 300 mm', category: 'Measuring', interval: 365, daysAgo: 20 },
  { tag: 'DFT-0401', name: 'Paint Thickness Gauge', category: 'Measuring', interval: 90, daysAgo: 85 },
  { tag: 'CR-0501', name: 'Hydraulic Crimping Tool', category: 'Electrical', interval: null, daysAgo: null },
  { tag: 'BS-0601', name: 'Inspection Borescope', category: 'Inspection', interval: null, daysAgo: null },
  { tag: 'IW-0701', name: 'Pneumatic Impact Wrench', category: 'Power Tools', interval: null, daysAgo: null },
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
                         calibration_interval_days, last_calibrated_on, calibration_due_on)
      VALUES (${t.tag}, ${t.name}, ${t.category}, ${mainCrib!.id}, ${cal}, ${t.interval},
              ${cal ? sql`current_date - ${t.daysAgo}::int` : null},
              ${cal ? sql`current_date - ${t.daysAgo}::int + ${t.interval}::int` : null})
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
  });
  return { wiped };
}
