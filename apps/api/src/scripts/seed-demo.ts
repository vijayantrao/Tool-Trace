/**
 * Loads fictional demo data: locations and tools in a range of calibration
 * states, including one that is expired so the lockout can be demonstrated.
 * Idempotent: safe to run more than once.
 */
import { createDb } from '../db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const locations = [
  { name: 'Main Tool Crib', kind: 'crib' },
  { name: 'Assembly Bay 1', kind: 'bay' },
  { name: 'Assembly Bay 2', kind: 'bay' },
  { name: 'Paint Line', kind: 'line' },
  { name: 'External Calibration Lab', kind: 'external' },
];

// daysAgo: when it was last calibrated. With the interval this sets the calibration state.
const tools = [
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

const sql = createDb(url, { max: 1 });
try {
  for (const l of locations) {
    await sql`INSERT INTO locations (name, kind) VALUES (${l.name}, ${l.kind}) ON CONFLICT (name) DO NOTHING`;
  }
  const [crib] = await sql<{ id: string }[]>`SELECT id FROM locations WHERE name = 'Main Tool Crib'`;
  for (const t of tools) {
    const cal = t.interval !== null;
    await sql`
      INSERT INTO tools (asset_tag, name, category, home_location_id, requires_calibration,
                         calibration_interval_days, last_calibrated_on, calibration_due_on)
      VALUES (${t.tag}, ${t.name}, ${t.category}, ${crib!.id}, ${cal}, ${t.interval},
              ${cal ? sql`current_date - ${t.daysAgo}::int` : null},
              ${cal ? sql`current_date - ${t.daysAgo}::int + ${t.interval}::int` : null})
      ON CONFLICT (asset_tag) DO NOTHING`;
  }
  console.log(`[seed] ${locations.length} locations and ${tools.length} tools ready`);
} finally {
  await sql.end();
}
